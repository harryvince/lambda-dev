import { TextEncoder } from "node:util";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  type FunctionConfiguration,
  type LambdaClient,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  InvokeCommand,
  UpdateFunctionCodeCommand,
} from "@aws-sdk/client-lambda";
import { AwsLambdaAdapter, createLambdaClient } from "../src/aws.js";
import { formatError } from "../src/output.js";
import type { LoadedTarget } from "../src/config.js";
import { sha256Base64 } from "../src/snapshot.js";

describe("aws adapter", () => {
  it("updates Lambda function code with zip bytes", async () => {
    const send = vi.fn().mockResolvedValue({ Version: "7", $metadata: { requestId: "req-1" } });
    const adapter = new AwsLambdaAdapter(fakeClient(send));
    const result = await adapter.updateFunctionCode(loadedTarget(), new Uint8Array([1, 2, 3]));

    expect(send).toHaveBeenCalledWith(expect.any(UpdateFunctionCodeCommand));
    expect(result).toMatchObject({
      functionName: "dev-function",
      version: "7",
      requestId: "req-1",
    });
  });

  it("sends every payload as JSON, including strings", async () => {
    const send = vi.fn().mockResolvedValue({ StatusCode: 200, $metadata: {} });
    const adapter = new AwsLambdaAdapter(fakeClient(send));

    await adapter.invokeFunction(loadedTarget(), "hello");
    await adapter.invokeFunction(loadedTarget(), { ok: true });

    const sent = send.mock.calls.map(([command]) =>
      new TextDecoder().decode(command.input.Payload),
    );

    expect(sent).toEqual(['"hello"', '{"ok":true}']);
  });

  it("invokes Lambda and decodes response payload and log tail", async () => {
    const send = vi.fn().mockResolvedValue({
      StatusCode: 200,
      ExecutedVersion: "$LATEST",
      LogResult: Buffer.from("hello logs").toString("base64"),
      Payload: new TextEncoder().encode(JSON.stringify({ ok: true })),
      $metadata: { requestId: "req-2" },
    });

    const adapter = new AwsLambdaAdapter(fakeClient(send));
    const result = await adapter.invokeFunction(loadedTarget(), { event: true });

    expect(send).toHaveBeenCalledWith(expect.any(InvokeCommand));
    expect(result.payload).toEqual({ ok: true });
    expect(result.logTail).toBe("hello logs");
  });

  it("names the configured profile when credentials can't be loaded", async () => {
    const credentialsError = Object.assign(
      new Error("Could not load credentials from any providers"),
      {
        name: "CredentialsProviderError",
      },
    );

    const send = vi.fn().mockRejectedValue(credentialsError);
    const adapter = new AwsLambdaAdapter(fakeClient(send));

    const target = {
      ...loadedTarget(),
      target: { ...loadedTarget().target, profile: "dev-profile" },
    };

    await expect(adapter.updateFunctionCode(target, new Uint8Array([1]))).rejects.toMatchObject({
      category: "aws_deploy",
      hint: expect.stringContaining('AWS profile "dev-profile"'),
    });
    await expect(adapter.invokeFunction(loadedTarget(), {})).rejects.toMatchObject({
      category: "aws_invoke",
      hint: expect.stringContaining("No AWS credentials found"),
    });
  });

  it("creates a client for region/profile configuration", () => {
    const client = createLambdaClient({ ...loadedTarget().target, profile: "dev-profile" });
    expect(client.config.region).toBeDefined();
    expect(client.config.profile).toBe("dev-profile");
  });

  it("leaves the profile unset so the default credential chain applies", () => {
    expect(createLambdaClient(loadedTarget().target).config.profile).toBeUndefined();
  });
});

function fakeClient(send: Mock): () => LambdaClient {
  // SAFETY: the adapter and the SDK's update waiter only call client.send(), which the mock provides.
  return () => ({ send }) as never;
}

function loadedTarget(): LoadedTarget {
  return {
    configPath: "/tmp/lambda-dev.yml",
    projectRoot: "/tmp",
    targetName: "dev",
    target: {
      functionName: "dev-function",
      region: "eu-west-2",
      snapshot: true,
      build: {
        entry: "handler.ts",
        bundle: true,
        platform: "node",
        target: "node20",
        format: "cjs",
        sourcemap: true,
        minify: false,
        external: [],
        define: {},
        copy: [],
        cache: false,
        outDir: ".lambda-dev/dev",
      },
      watch: { include: ["src/**/*.ts"], exclude: [], debounceMs: 300 },
      invoke: { afterDeploy: false, logType: "Tail" },
      checks: {},
    },
  };
}

const PRIVATE_VALUE = "FAKE_ENV_PRIVATE_VALUE";

const ready = (variables: Record<string, string> = {}, revision = "rev-1") => ({
  State: "Active",
  LastUpdateStatus: "Successful",
  RevisionId: revision,
  Environment: { Variables: variables },
  $metadata: {},
});

const patchedTarget = () => {
  const loaded = loadedTarget();
  loaded.target.environment = { LOG_LEVEL: "debug", OLD_FLAG: null, EMPTY: "" };

  return loaded;
};

afterEach(() => vi.useRealTimers());

describe("Lambda environment synchronization", () => {
  it("sends a revision-guarded merged environment and waits before returning", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(ready({ KEEP: PRIVATE_VALUE, OLD_FLAG: "old" }))
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce(ready({ KEEP: PRIVATE_VALUE, LOG_LEVEL: "debug", EMPTY: "" }));

    let release!: (value: never) => void;

    const wait = vi.fn(
      () =>
        new Promise<never>((resolve) => {
          release = resolve;
        }),
    );

    const adapter = new AwsLambdaAdapter(fakeClient(send), wait);
    const completed = vi.fn();

    const pending = adapter.updateEnvironment(patchedTarget()).then((result) => {
      completed(result);

      return result;
    });

    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateFunctionConfigurationCommand);
    expect(send.mock.calls[1][0].input).toEqual({
      FunctionName: "dev-function",
      RevisionId: "rev-1",
      Environment: { Variables: { KEEP: PRIVATE_VALUE, LOG_LEVEL: "debug", EMPTY: "" } },
    });
    expect(wait.mock.calls[0]).toEqual([
      expect.objectContaining({
        maxWaitTime: 120,
        minDelay: 1,
        maxDelay: 5,
        abortSignal: expect.any(AbortSignal),
      }),
      { FunctionName: "dev-function" },
    ]);
    // SAFETY: the adapter ignores the waiter's result, so any value releases it.
    release({ state: "SUCCESS" } as never);
    expect(await pending).toEqual({ changed: true, updatedCount: 2, deletedCount: 1 });
    expect(JSON.stringify(await pending)).not.toContain(PRIVATE_VALUE);
  });

  it("waits for an in-progress operation and uses a freshly read revision", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ...ready(), LastUpdateStatus: "InProgress" })
      .mockResolvedValueOnce(ready({ RETAIN: "yes" }, "fresh-rev"))
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce(ready());

    const wait = vi.fn().mockResolvedValue({ state: "SUCCESS" });
    await new AwsLambdaAdapter(fakeClient(send), wait).updateEnvironment(patchedTarget());
    expect(wait).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[2][0].input.RevisionId).toBe("fresh-rev");
    expect(send.mock.calls[2][0].input.Environment.Variables.RETAIN).toBe("yes");
  });

  it("treats absent environment as empty and performs no work for omitted/empty patches", async () => {
    const send = vi.fn();
    const wait = vi.fn();
    const adapter = new AwsLambdaAdapter(fakeClient(send), wait);
    await adapter.updateEnvironment(loadedTarget());
    const empty = loadedTarget();
    empty.target.environment = {};
    await adapter.updateEnvironment(empty);
    expect(send).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    send
      .mockResolvedValueOnce({ ...ready(), Environment: undefined })
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce(ready());
    wait.mockResolvedValue({ state: "SUCCESS" });
    expect((await adapter.updateEnvironment(patchedTarget())).changed).toBe(true);
  });

  it("skips unchanged writes and absent deletions without needing a revision", async () => {
    const send = vi.fn().mockResolvedValue({
      ...ready({ LOG_LEVEL: "debug", EMPTY: "", KEEP: PRIVATE_VALUE }),
      RevisionId: undefined,
    });

    const wait = vi.fn();

    const result = await new AwsLambdaAdapter(fakeClient(send), wait).updateEnvironment(
      patchedTarget(),
    );

    expect(result.changed).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it.each([
    {
      ...ready(),
      Environment: { Variables: { KEEP: PRIVATE_VALUE }, Error: { Message: PRIVATE_VALUE } },
    },
    { ...ready(), Environment: null },
    { ...ready(), Environment: { Variables: null } },
    { ...ready(), Environment: { Variables: { KEEP: 42 } } },
    { ...ready(), RevisionId: undefined },
    { ...ready(), State: "Inactive" },
    { ...ready(), State: "Failed" },
    { ...ready(), LastUpdateStatus: "Failed" },
    { ...ready(), Environment: { Variables: { KEEP: PRIVATE_VALUE.repeat(500) } } },
  ])("fails closed on unsafe configuration response %#", async (configuration) => {
    const send = vi.fn().mockResolvedValue(configuration);
    const adapter = new AwsLambdaAdapter(fakeClient(send));

    try {
      await adapter.updateEnvironment(patchedTarget());
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ category: "aws_configuration" });
      expect(formatError(error)).not.toContain(PRIVATE_VALUE);
    }

    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["AccessDeniedException", "PreconditionFailedException", PRIVATE_VALUE])(
    "sanitizes SDK errors and never retries a stale write (%s)",
    async (name) => {
      const failure = Object.assign(new Error(PRIVATE_VALUE), { name });
      const send = vi.fn().mockResolvedValueOnce(ready()).mockRejectedValueOnce(failure);

      try {
        await new AwsLambdaAdapter(fakeClient(send)).updateEnvironment(patchedTarget());
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toMatchObject({ category: "aws_configuration" });
        expect(formatError(error)).not.toContain(PRIVATE_VALUE);

        if (name === "PreconditionFailedException")
          expect(formatError(error)).toContain("fresh revision");
      }

      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it("sanitizes read failures before any write", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error(PRIVATE_VALUE), { name: "AccessDeniedException" }),
      );

    const pending = new AwsLambdaAdapter(fakeClient(send)).updateEnvironment(patchedTarget());

    await expect(pending).rejects.toMatchObject({
      category: "aws_configuration",
      message: expect.not.stringContaining(PRIVATE_VALUE),
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("sanitizes waiter reasons containing the environment, and skips further reads", async () => {
    const send = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce({ $metadata: {} });

    const wait = vi
      .fn()
      .mockRejectedValue(new Error(JSON.stringify({ reason: ready({ VALUE: PRIVATE_VALUE }) })));

    await expect(
      new AwsLambdaAdapter(fakeClient(send), wait).updateEnvironment(patchedTarget()),
    ).rejects.toMatchObject({
      category: "aws_configuration",
      message: expect.stringContaining("environment update"),
      hint: expect.not.stringContaining(PRIVATE_VALUE),
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses the real SDK configuration waiter and verifies Active after success", async () => {
    const send = vi.fn().mockResolvedValue(ready());
    await new AwsLambdaAdapter(fakeClient(send)).waitForUpdate(patchedTarget());
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(([command]) => command instanceof GetFunctionConfigurationCommand),
    ).toBe(true);
    send
      .mockReset()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ ...ready(), State: "Pending" });
    await expect(
      new AwsLambdaAdapter(fakeClient(send)).waitForUpdate(patchedTarget()),
    ).rejects.toMatchObject({ category: "aws_configuration" });
  });

  it("stops on a real SDK failed update without exposing its reason payload", async () => {
    const send = vi.fn().mockResolvedValue({
      ...ready({ VALUE: PRIVATE_VALUE }),
      LastUpdateStatus: "Failed",
      LastUpdateStatusReason: PRIVATE_VALUE,
    });

    await expect(
      new AwsLambdaAdapter(fakeClient(send)).waitForUpdate(patchedTarget()),
    ).rejects.toMatchObject({
      category: "aws_configuration",
      message: expect.stringContaining("code update"),
      hint: expect.not.stringContaining(PRIVATE_VALUE),
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("fails if environment access becomes unavailable after an accepted update", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce({ ...ready(), Environment: { Error: { Message: PRIVATE_VALUE } } });

    const wait = vi.fn().mockResolvedValue({ state: "SUCCESS" });
    await expect(
      new AwsLambdaAdapter(fakeClient(send), wait).updateEnvironment(patchedTarget()),
    ).rejects.toMatchObject({
      category: "aws_configuration",
      message: expect.not.stringContaining(PRIVATE_VALUE),
    });
  });

  it("bounds the real SDK waiter at 120 seconds without real sleeping", async () => {
    vi.useFakeTimers();

    const send = vi
      .fn()
      .mockResolvedValue({ ...ready({ VALUE: PRIVATE_VALUE }), LastUpdateStatus: "InProgress" });

    const assertion = expect(
      new AwsLambdaAdapter(fakeClient(send)).waitForUpdate(patchedTarget()),
    ).rejects.toMatchObject({
      category: "aws_configuration",
      message: expect.stringContaining("code update"),
      hint: expect.not.stringContaining(PRIVATE_VALUE),
    });

    await vi.advanceTimersByTimeAsync(121_000);
    await assertion;
  });

  it("sanitizes upload failures in environment-enabled deployments", async () => {
    const send = vi.fn().mockRejectedValue(new Error(PRIVATE_VALUE));
    await expect(
      new AwsLambdaAdapter(fakeClient(send)).updateFunctionCode(
        patchedTarget(),
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({
      category: "aws_deploy",
      message: expect.not.stringContaining(PRIVATE_VALUE),
      hint: expect.not.stringContaining(PRIVATE_VALUE),
    });
  });
});

describe("rollback snapshot reads and restores", () => {
  const code = new Uint8Array([4, 5, 6]);

  const getFunction = (configuration: FunctionConfiguration = {}) => ({
    Configuration: {
      PackageType: "Zip",
      CodeSha256: sha256Base64(code),
      Environment: { Variables: { KEEP: PRIVATE_VALUE } },
      ...configuration,
    },
    Code: { Location: "https://example.invalid/code.zip" },
    $metadata: {},
  });

  it("downloads the code and environment and checks the code against its checksum", async () => {
    const send = vi.fn().mockResolvedValue(getFunction());
    const download = vi.fn().mockResolvedValue(code);
    const adapter = new AwsLambdaAdapter(fakeClient(send), vi.fn(), download);

    expect(await adapter.downloadFunction(loadedTarget())).toEqual({
      code,
      codeSha256: sha256Base64(code),
      environment: { KEEP: PRIVATE_VALUE },
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetFunctionCommand);
    expect(download).toHaveBeenCalledWith("https://example.invalid/code.zip");

    download.mockResolvedValue(new Uint8Array([0]));
    await expect(adapter.downloadFunction(loadedTarget())).rejects.toMatchObject({
      category: "aws_snapshot",
      message: expect.stringContaining("checksum"),
    });
  });

  it.each([
    [getFunction({ PackageType: "Image" }), "container image"],
    [getFunction({ Environment: { Error: { Message: PRIVATE_VALUE } } }), "environment"],
  ])("refuses functions it can't snapshot %#", async (response, message) => {
    const adapter = new AwsLambdaAdapter(
      fakeClient(vi.fn().mockResolvedValue(response)),
      vi.fn(),
      vi.fn().mockResolvedValue(code),
    );

    try {
      await adapter.downloadFunction(loadedTarget());
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ category: "aws_snapshot" });
      expect(formatError(error)).toContain(message);
      expect(formatError(error)).not.toContain(PRIVATE_VALUE);
    }
  });

  it("points at lambda:GetFunction and snapshot: false when access is denied", async () => {
    const denied = Object.assign(new Error(PRIVATE_VALUE), { name: "AccessDeniedException" });
    const adapter = new AwsLambdaAdapter(fakeClient(vi.fn().mockRejectedValue(denied)));

    await expect(adapter.downloadFunction(loadedTarget())).rejects.toMatchObject({
      category: "aws_snapshot",
      message: expect.not.stringContaining(PRIVATE_VALUE),
      hint: expect.stringMatching(/lambda:GetFunction.*snapshot: false/),
    });
  });

  it("restores the exact environment, deleting variables added since", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(ready({ KEEP: "changed", ADDED: "x" }))
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce(ready({ KEEP: PRIVATE_VALUE }));

    const wait = vi.fn().mockResolvedValue({ state: "SUCCESS" });

    const result = await new AwsLambdaAdapter(fakeClient(send), wait).restoreEnvironment(
      loadedTarget(),
      { KEEP: PRIVATE_VALUE },
    );

    expect(send.mock.calls[1][0].input).toEqual({
      FunctionName: "dev-function",
      RevisionId: "rev-1",
      Environment: { Variables: { KEEP: PRIVATE_VALUE } },
    });
    expect(result).toEqual({ changed: true, updatedCount: 1, deletedCount: 1 });
  });
});
