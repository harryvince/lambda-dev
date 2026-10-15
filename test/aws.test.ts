import { TextEncoder } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand, InvokeCommand, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda";
import { AwsLambdaAdapter, createLambdaClient } from "../src/aws.js";
import { formatError } from "../src/output.js";
import type { LoadedTarget } from "../src/config.js";

describe("aws adapter", () => {
  it("updates Lambda function code with zip bytes", async () => {
    const send = vi.fn().mockResolvedValue({ Version: "7", $metadata: { requestId: "req-1" } });
    const adapter = new AwsLambdaAdapter(() => ({ send }) as never);
    const result = await adapter.updateFunctionCode(loadedTarget(), new Uint8Array([1, 2, 3]));

    expect(send).toHaveBeenCalledWith(expect.any(UpdateFunctionCodeCommand));
    expect(result).toMatchObject({
      functionName: "dev-function",
      version: "7",
      requestId: "req-1",
    });
  });

  it("invokes Lambda and decodes response payload and log tail", async () => {
    const send = vi.fn().mockResolvedValue({
      StatusCode: 200,
      ExecutedVersion: "$LATEST",
      LogResult: Buffer.from("hello logs").toString("base64"),
      Payload: new TextEncoder().encode(JSON.stringify({ ok: true })),
      $metadata: { requestId: "req-2" },
    });
    const adapter = new AwsLambdaAdapter(() => ({ send }) as never);
    const result = await adapter.invokeFunction(loadedTarget(), { event: true });

    expect(send).toHaveBeenCalledWith(expect.any(InvokeCommand));
    expect(result.payload).toEqual({ ok: true });
    expect(result.logTail).toBe("hello logs");
  });

  it("creates a client for region/profile configuration", () => {
    const client = createLambdaClient({ ...loadedTarget().target, profile: "dev-profile" });
    expect(client.config.region).toBeDefined();
  });
});

function loadedTarget(): LoadedTarget {
  return {
    configPath: "/tmp/lambda-dev.yml",
    projectRoot: "/tmp",
    targetName: "dev",
    target: {
      functionName: "dev-function",
      region: "eu-west-2",
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
        outDir: ".lambda-dev/dev",
      },
      watch: { include: ["src/**/*.ts"], exclude: [], debounceMs: 300 },
      invoke: { afterDeploy: false, logType: "Tail" },
    },
  };
}


const PRIVATE_VALUE = "FAKE_ENV_PRIVATE_VALUE";
const ready = (variables: Record<string, string> = {}, revision = "rev-1") => ({
  State: "Active", LastUpdateStatus: "Successful", RevisionId: revision,
  Environment: { Variables: variables }, $metadata: {},
});
const patchedTarget = () => {
  const loaded = loadedTarget();
  loaded.target.environment = { LOG_LEVEL: "debug", OLD_FLAG: null, EMPTY: "" };
  return loaded;
};

afterEach(() => vi.useRealTimers());

describe("Lambda environment synchronization", () => {
  it("sends a revision-guarded merged environment and waits before returning", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(ready({ KEEP: PRIVATE_VALUE, OLD_FLAG: "old" }))
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce(ready({ KEEP: PRIVATE_VALUE, LOG_LEVEL: "debug", EMPTY: "" }));
    let release!: (value: never) => void;
    const wait = vi.fn(() => new Promise<never>((resolve) => { release = resolve; }));
    const adapter = new AwsLambdaAdapter(() => ({ send }) as never, wait);
    const completed = vi.fn();
    const pending = adapter.updateEnvironment(patchedTarget()).then((result) => { completed(result); return result; });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateFunctionConfigurationCommand);
    expect(send.mock.calls[1][0].input).toEqual({ FunctionName: "dev-function", RevisionId: "rev-1",
      Environment: { Variables: { KEEP: PRIVATE_VALUE, LOG_LEVEL: "debug", EMPTY: "" } },
    });
    expect(wait.mock.calls[0]).toEqual([
      expect.objectContaining({ maxWaitTime: 120, minDelay: 1, maxDelay: 5, abortSignal: expect.any(AbortSignal) }),
      { FunctionName: "dev-function" },
    ]);
    release({ state: "SUCCESS" } as never);
    expect(await pending).toEqual({ changed: true, updatedCount: 2, deletedCount: 1 });
    expect(JSON.stringify(await pending)).not.toContain(PRIVATE_VALUE);
  });

  it("waits for an in-progress operation and uses a freshly read revision", async () => {
    const send = vi.fn().mockResolvedValueOnce({ ...ready(), LastUpdateStatus: "InProgress" })
      .mockResolvedValueOnce(ready({ RETAIN: "yes" }, "fresh-rev"))
      .mockResolvedValueOnce({ $metadata: {} }).mockResolvedValueOnce(ready());
    const wait = vi.fn().mockResolvedValue({ state: "SUCCESS" });
    await new AwsLambdaAdapter(() => ({ send }) as never, wait).updateEnvironment(patchedTarget());
    expect(wait).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[2][0].input.RevisionId).toBe("fresh-rev");
    expect(send.mock.calls[2][0].input.Environment.Variables.RETAIN).toBe("yes");
  });

  it("treats absent environment as empty and performs no work for omitted/empty patches", async () => {
    const send = vi.fn(); const wait = vi.fn();
    const adapter = new AwsLambdaAdapter(() => ({ send }) as never, wait);
    await adapter.updateEnvironment(loadedTarget());
    const empty = loadedTarget(); empty.target.environment = {};
    await adapter.updateEnvironment(empty);
    expect(send).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({ ...ready(), Environment: undefined })
      .mockResolvedValueOnce({ $metadata: {} }).mockResolvedValueOnce(ready());
    wait.mockResolvedValue({ state: "SUCCESS" });
    expect((await adapter.updateEnvironment(patchedTarget())).changed).toBe(true);
  });

  it("skips unchanged writes and absent deletions without needing a revision", async () => {
    const send = vi.fn().mockResolvedValue({ ...ready({ LOG_LEVEL: "debug", EMPTY: "", KEEP: PRIVATE_VALUE }), RevisionId: undefined });
    const wait = vi.fn();
    const result = await new AwsLambdaAdapter(() => ({ send }) as never, wait).updateEnvironment(patchedTarget());
    expect(result.changed).toBe(false); expect(send).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
  });

  it.each([
    { ...ready(), Environment: { Variables: { KEEP: PRIVATE_VALUE }, Error: { Message: PRIVATE_VALUE } } },
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
    const adapter = new AwsLambdaAdapter(() => ({ send }) as never);
    try { await adapter.updateEnvironment(patchedTarget()); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toMatchObject({ category: "aws_configuration" });
      expect(formatError(error)).not.toContain(PRIVATE_VALUE);
    }
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["AccessDeniedException", "PreconditionFailedException", PRIVATE_VALUE])(
    "sanitizes SDK errors and never retries a stale write (%s)", async (name) => {
      const failure = Object.assign(new Error(PRIVATE_VALUE), { name });
      const send = vi.fn().mockResolvedValueOnce(ready()).mockRejectedValueOnce(failure);
      try { await new AwsLambdaAdapter(() => ({ send }) as never).updateEnvironment(patchedTarget()); throw new Error("Expected rejection"); }
      catch (error) {
        expect(error).toMatchObject({ category: "aws_configuration" });
        expect(formatError(error)).not.toContain(PRIVATE_VALUE);
        if (name === "PreconditionFailedException") expect(formatError(error)).toContain("fresh revision");
      }
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it("sanitizes read failures before any write", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error(PRIVATE_VALUE), { name: "AccessDeniedException" }));
    const pending = new AwsLambdaAdapter(() => ({ send }) as never).updateEnvironment(patchedTarget());
    await expect(pending).rejects.toMatchObject({ category: "aws_configuration", message: expect.not.stringContaining(PRIVATE_VALUE) });
    expect(send).toHaveBeenCalledOnce();
  });

  it("sanitizes waiter reasons containing the environment, and skips further reads", async () => {
    const send = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce({ $metadata: {} });
    const wait = vi.fn().mockRejectedValue(new Error(JSON.stringify({ reason: ready({ VALUE: PRIVATE_VALUE }) })));
    await expect(new AwsLambdaAdapter(() => ({ send }) as never, wait).updateEnvironment(patchedTarget()))
      .rejects.toMatchObject({ category: "aws_configuration", message: expect.stringContaining("environment update"), hint: expect.not.stringContaining(PRIVATE_VALUE) });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses the real SDK configuration waiter and verifies Active after success", async () => {
    const send = vi.fn().mockResolvedValue(ready());
    await new AwsLambdaAdapter(() => ({ send }) as never).waitForUpdate(patchedTarget());
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([command]) => command instanceof GetFunctionConfigurationCommand)).toBe(true);
    send.mockReset().mockResolvedValueOnce(ready()).mockResolvedValueOnce({ ...ready(), State: "Pending" });
    await expect(new AwsLambdaAdapter(() => ({ send }) as never).waitForUpdate(patchedTarget()))
      .rejects.toMatchObject({ category: "aws_configuration" });
  });

  it("stops on a real SDK failed update without exposing its reason payload", async () => {
    const send = vi.fn().mockResolvedValue({ ...ready({ VALUE: PRIVATE_VALUE }), LastUpdateStatus: "Failed", LastUpdateStatusReason: PRIVATE_VALUE });
    await expect(new AwsLambdaAdapter(() => ({ send }) as never).waitForUpdate(patchedTarget()))
      .rejects.toMatchObject({ category: "aws_configuration", message: expect.stringContaining("code update"), hint: expect.not.stringContaining(PRIVATE_VALUE) });
    expect(send).toHaveBeenCalledOnce();
  });

  it("fails if environment access becomes unavailable after an accepted update", async () => {
    const send = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce({ ...ready(), Environment: { Error: { Message: PRIVATE_VALUE } } });
    const wait = vi.fn().mockResolvedValue({ state: "SUCCESS" });
    await expect(new AwsLambdaAdapter(() => ({ send }) as never, wait).updateEnvironment(patchedTarget()))
      .rejects.toMatchObject({ category: "aws_configuration", message: expect.not.stringContaining(PRIVATE_VALUE) });
  });

  it("bounds the real SDK waiter at 120 seconds without real sleeping", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue({ ...ready({ VALUE: PRIVATE_VALUE }), LastUpdateStatus: "InProgress" });
    const assertion = expect(new AwsLambdaAdapter(() => ({ send }) as never).waitForUpdate(patchedTarget()))
      .rejects.toMatchObject({ category: "aws_configuration", message: expect.stringContaining("code update"), hint: expect.not.stringContaining(PRIVATE_VALUE) });
    await vi.advanceTimersByTimeAsync(121_000);
    await assertion;
  });

  it("sanitizes upload failures in environment-enabled deployments", async () => {
    const send = vi.fn().mockRejectedValue(new Error(PRIVATE_VALUE));
    await expect(new AwsLambdaAdapter(() => ({ send }) as never).updateFunctionCode(patchedTarget(), new Uint8Array([1])))
      .rejects.toMatchObject({ category: "aws_deploy", message: expect.not.stringContaining(PRIVATE_VALUE), hint: expect.not.stringContaining(PRIVATE_VALUE) });
  });
});
