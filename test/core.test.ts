import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildTarget,
  checkTarget,
  deployTarget,
  formatInvokeSummary,
  invokeTarget,
  rollbackTarget,
  validateTarget,
} from "../src/core.js";
import { LambdaDevError } from "../src/errors.js";
import type { EnvironmentUpdateResult, LambdaAdapter } from "../src/aws.js";
import { readSnapshot, sha256Base64, snapshotDirectory } from "../src/snapshot.js";

describe("core use cases", () => {
  it("deploys once and invokes after upload when configured", async () => {
    const configPath = await writeProjectConfig(true);

    const buildArtifact = vi.fn().mockResolvedValue({
      artifactPath: "/tmp/function.zip",
      artifactBytes: new Uint8Array([1]),
      sizeBytes: 1,
      durationMs: 5,
      cached: false,
    });

    const lambda = fakeLambda();

    const result = await deployTarget({
      configPath,
      logger: memoryLogger(),
      deps: { buildArtifact, lambda },
    });

    expect(buildArtifact).toHaveBeenCalledOnce();
    expect(lambda.updateFunctionCode).toHaveBeenCalledOnce();
    expect(lambda.updateEnvironment).not.toHaveBeenCalled();
    expect(lambda.waitForUpdate).not.toHaveBeenCalled();
    expect(lambda.invokeFunction).toHaveBeenCalledOnce();
    expect(result.invoke?.statusCode).toBe(200);
  });

  it("turns the build cache off for one deploy with cache: false", async () => {
    const configPath = await writeProjectConfig(false);
    const logger = memoryLogger();

    const buildArtifact = vi.fn().mockResolvedValue({
      artifactPath: "/tmp/function.zip",
      artifactBytes: new Uint8Array([1]),
      sizeBytes: 1,
      durationMs: 5,
      cached: true,
    });

    await deployTarget({ configPath, logger, deps: { buildArtifact, lambda: fakeLambda() } });
    expect(buildArtifact.mock.calls[0]?.[0].target.build.cache).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Reused cached build for /tmp/function.zip"),
    );

    await deployTarget({
      configPath,
      cache: false,
      logger,
      deps: { buildArtifact, lambda: fakeLambda() },
    });
    expect(buildArtifact.mock.calls[1]?.[0].target.build.cache).toBe(false);
  });

  it("skips invoke after deploy unless requested or configured", async () => {
    const configPath = await writeProjectConfig(false);
    const lambda = fakeLambda();

    await deployTarget({
      configPath,
      logger: memoryLogger(),
      deps: {
        buildArtifact: vi.fn().mockResolvedValue({
          artifactPath: "/tmp/function.zip",
          artifactBytes: new Uint8Array([1]),
          sizeBytes: 1,
          durationMs: 5,
          cached: false,
        }),
        lambda,
      },
    });

    expect(lambda.updateFunctionCode).toHaveBeenCalledOnce();
    expect(lambda.invokeFunction).not.toHaveBeenCalled();
  });

  it("invoke command does not build by default", async () => {
    const configPath = await writeProjectConfig(false);
    const buildArtifact = vi.fn();
    const lambda = fakeLambda();

    await invokeTarget({
      configPath,
      payloadJson: '{"ok":true}',
      logger: memoryLogger(),
      deps: { buildArtifact, lambda },
    });

    expect(buildArtifact).not.toHaveBeenCalled();
    expect(lambda.invokeFunction).toHaveBeenCalledOnce();
  });

  it("skips AWS upload and invoke when a configured copy source is missing", async () => {
    const configPath = await writeProjectConfig(true);
    const fs = await import("node:fs/promises");
    const contents = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      contents.replace(
        "entry: src/handler.ts",
        "entry: src/handler.ts\n      copy: [{ from: missing-runtime.bin, to: bin/helper }]",
      ),
    );
    const lambda = fakeLambda();
    await expect(
      deployTarget({ configPath, logger: memoryLogger(), deps: { lambda } }),
    ).rejects.toMatchObject({ category: "build" });
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
    expect(lambda.invokeFunction).not.toHaveBeenCalled();
  });

  it("formats invoke results with key fields", () => {
    expect(
      formatInvokeSummary({ statusCode: 200, functionError: "Unhandled", payload: { ok: false } }),
    ).toContain("functionError Unhandled");
  });
});

const ORIGINAL_CODE = new Uint8Array([9, 9, 9]);

function fakeLambda(): LambdaAdapter {
  return {
    updateEnvironment: vi
      .fn()
      .mockResolvedValue({ changed: false, updatedCount: 0, deletedCount: 0 }),
    restoreEnvironment: vi
      .fn()
      .mockResolvedValue({ changed: true, updatedCount: 1, deletedCount: 1, revisionId: "rev-9" }),
    downloadFunction: vi.fn().mockResolvedValue({
      code: ORIGINAL_CODE,
      codeSha256: sha256Base64(ORIGINAL_CODE),
      environment: { ORIGINAL: "FAKE_SNAPSHOT_VALUE" },
    }),
    waitForUpdate: vi.fn().mockResolvedValue(undefined),
    updateFunctionCode: vi.fn().mockResolvedValue({ functionName: "dev-function", version: "1" }),
    invokeFunction: vi.fn().mockResolvedValue({ statusCode: 200, payload: { ok: true } }),
  };
}

function memoryLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function writeProjectConfig(afterDeploy: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lambda-dev-core-"));
  await writeFile(path.join(dir, "event.json"), JSON.stringify({ hello: "world" }));
  const configPath = path.join(dir, "lambda-dev.yml");
  await writeFile(
    configPath,
    `version: 1
defaultTarget: dev
targets:
  dev:
    functionName: dev-function
    region: eu-west-2
    build:
      entry: src/handler.ts
    invoke:
      afterDeploy: ${afterDeploy}
      payloadFile: event.json
`,
  );

  return configPath;
}

async function environmentConfig(environment = "{ LOG_LEVEL: debug, REMOVE: null }") {
  const file = await writeProjectConfig(true);
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "    build:",
      `    environment: ${environment}\n    build:`,
    ),
  );

  return file;
}

const built = () => ({
  artifactPath: "/tmp/function.zip",
  artifactBytes: new Uint8Array([1]),
  sizeBytes: 1,
  durationMs: 1,
  cached: false,
});

describe("environment deployment orchestration", () => {
  it("awaits environment synchronization and code completion before invocation", async () => {
    const file = await environmentConfig();
    const events: string[] = [];
    const lambda = fakeLambda();

    let releaseEnvironment!: (value: EnvironmentUpdateResult) => void;

    let releaseCode!: () => void;
    lambda.updateEnvironment = vi.fn(() => {
      events.push("environment");

      return new Promise<EnvironmentUpdateResult>((resolve) => {
        releaseEnvironment = resolve;
      });
    });
    lambda.updateFunctionCode = vi.fn(async () => {
      events.push("upload");

      return { functionName: "dev-function" };
    });
    lambda.waitForUpdate = vi.fn(() => {
      events.push("wait");

      return new Promise<void>((resolve) => {
        releaseCode = resolve;
      });
    });
    lambda.invokeFunction = vi.fn(async () => {
      events.push("invoke");

      return { statusCode: 200 };
    });

    const pending = deployTarget({
      configPath: file,
      logger: memoryLogger(),
      deps: {
        lambda,
        buildArtifact: vi.fn(async () => {
          events.push("build");

          return built();
        }),
      },
    });

    await vi.waitFor(() => expect(lambda.updateEnvironment).toHaveBeenCalledOnce());
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
    releaseEnvironment({ changed: true, updatedCount: 1, deletedCount: 1 });
    await vi.waitFor(() => expect(lambda.waitForUpdate).toHaveBeenCalledOnce());
    expect(lambda.invokeFunction).not.toHaveBeenCalled();
    releaseCode();
    expect((await pending).environment).toEqual({
      changed: true,
      updatedCount: 1,
      deletedCount: 1,
    });
    expect(events).toEqual(["build", "environment", "upload", "wait", "invoke"]);
  });

  it.each(["build", "environment", "upload", "wait"])(
    "stops later operations after %s fails",
    async (stage) => {
      const file = await environmentConfig();
      const lambda = fakeLambda();
      const build = vi.fn().mockResolvedValue(built());

      const failure = new LambdaDevError(
        stage === "build" ? "build" : "aws_configuration",
        "Safe failure",
      );

      if (stage === "build") build.mockRejectedValue(failure);

      if (stage === "environment") vi.mocked(lambda.updateEnvironment).mockRejectedValue(failure);

      if (stage === "upload") vi.mocked(lambda.updateFunctionCode).mockRejectedValue(failure);

      if (stage === "wait") vi.mocked(lambda.waitForUpdate).mockRejectedValue(failure);
      await expect(
        deployTarget({
          configPath: file,
          logger: memoryLogger(),
          deps: { lambda, buildArtifact: build },
        }),
      ).rejects.toBe(failure);
      expect(lambda.invokeFunction).not.toHaveBeenCalled();

      if (stage === "build") expect(lambda.updateEnvironment).not.toHaveBeenCalled();

      if (["build", "environment"].includes(stage))
        expect(lambda.updateFunctionCode).not.toHaveBeenCalled();

      if (stage !== "wait") expect(lambda.waitForUpdate).not.toHaveBeenCalled();
    },
  );

  it("still waits after code upload when the environment already matches", async () => {
    const lambda = fakeLambda();

    const result = await deployTarget({
      configPath: await environmentConfig(),
      invoke: false,
      logger: memoryLogger(),
      deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });

    expect(result.environment?.changed).toBe(false);
    expect(lambda.waitForUpdate).toHaveBeenCalledOnce();
    expect(lambda.invokeFunction).not.toHaveBeenCalled();
  });

  it("does not activate configuration calls for an empty map", async () => {
    const lambda = fakeLambda();
    await deployTarget({
      configPath: await environmentConfig("{}"),
      logger: memoryLogger(),
      deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });
    expect(lambda.updateEnvironment).not.toHaveBeenCalled();
    expect(lambda.waitForUpdate).not.toHaveBeenCalled();
  });

  it("keeps validate and standalone invoke free of environment mutations", async () => {
    const file = await environmentConfig();
    const lambda = fakeLambda();
    const build = vi.fn();
    expect((await validateTarget(file)).target.environment).toEqual({
      LOG_LEVEL: "debug",
      REMOVE: null,
    });
    await invokeTarget({
      configPath: file,
      logger: memoryLogger(),
      deps: { lambda, buildArtifact: build },
    });
    expect(build).not.toHaveBeenCalled();
    expect(lambda.updateEnvironment).not.toHaveBeenCalled();
    expect(lambda.waitForUpdate).not.toHaveBeenCalled();
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
  });

  it("does not put environment values into logs or successful summaries", async () => {
    const file = await environmentConfig(
      "{ ORDINARY_NAME: FAKE_PRIVATE_VALUE, API_KEY: FAKE_PRIVATE_VALUE }",
    );

    const logger = memoryLogger();
    const lambda = fakeLambda();

    const result = await deployTarget({
      configPath: file,
      invoke: false,
      logger,
      deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });

    expect(
      JSON.stringify([
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
        result,
      ]),
    ).not.toContain("FAKE_PRIVATE_VALUE");
  });
});

describe("rollback snapshots", () => {
  it("saves the function before the first deploy changes anything, and only once", async () => {
    const configPath = await environmentConfig();
    const events: string[] = [];
    const lambda = fakeLambda();

    vi.mocked(lambda.downloadFunction).mockImplementation(async () => {
      events.push("snapshot");

      return {
        code: ORIGINAL_CODE,
        codeSha256: sha256Base64(ORIGINAL_CODE),
        environment: { ORIGINAL: "FAKE_SNAPSHOT_VALUE" },
      };
    });
    vi.mocked(lambda.updateEnvironment).mockImplementation(async () => {
      events.push("environment");

      return { changed: true, updatedCount: 1, deletedCount: 0 };
    });

    const logger = memoryLogger();
    const deps = { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) };
    await deployTarget({ configPath, invoke: false, logger, deps });
    await deployTarget({ configPath, invoke: false, logger, deps });

    expect(events).toEqual(["snapshot", "environment", "environment"]);

    const loaded = await validateTarget(configPath);
    const snapshot = await readSnapshot(loaded);
    expect(snapshot?.code).toEqual(Buffer.from(ORIGINAL_CODE));
    expect(snapshot?.environment).toEqual({ ORIGINAL: "FAKE_SNAPSHOT_VALUE" });
    expect((await stat(path.join(snapshotDirectory(loaded), "snapshot.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("FAKE_SNAPSHOT_VALUE");
  });

  it("stops the deploy before any AWS change when the snapshot fails", async () => {
    const lambda = fakeLambda();
    vi.mocked(lambda.downloadFunction).mockRejectedValue(
      new LambdaDevError("aws_snapshot", "Failed"),
    );

    await expect(
      deployTarget({
        configPath: await environmentConfig(),
        logger: memoryLogger(),
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({ category: "aws_snapshot" });
    expect(lambda.updateEnvironment).not.toHaveBeenCalled();
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
  });

  it("skips the snapshot when the target sets snapshot: false", async () => {
    const configPath = await writeProjectConfig(false);
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace("    build:", "    snapshot: false\n    build:"),
    );

    const lambda = fakeLambda();
    await deployTarget({
      configPath,
      logger: memoryLogger(),
      deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });

    expect(lambda.downloadFunction).not.toHaveBeenCalled();
    expect(lambda.updateFunctionCode).toHaveBeenCalledOnce();
  });

  it("refuses an outDir that would delete the snapshots, before building", async () => {
    const configPath = await writeProjectConfig(false);
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "      entry: src/handler.ts",
        "      entry: src/handler.ts\n      outDir: .lambda-dev",
      ),
    );

    const buildArtifact = vi.fn();
    await expect(
      deployTarget({
        configPath,
        logger: memoryLogger(),
        deps: { lambda: fakeLambda(), buildArtifact },
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(buildArtifact).not.toHaveBeenCalled();
  });

  it("restores the environment and code, waits, then deletes the snapshot", async () => {
    const configPath = await writeProjectConfig(false);
    const lambda = fakeLambda();
    const deps = { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) };
    await deployTarget({ configPath, logger: memoryLogger(), deps });
    vi.mocked(lambda.updateFunctionCode).mockClear();

    const result = await rollbackTarget({ configPath, logger: memoryLogger(), deps });

    expect(lambda.restoreEnvironment).toHaveBeenCalledWith(expect.anything(), {
      ORIGINAL: "FAKE_SNAPSHOT_VALUE",
    });
    expect(lambda.updateFunctionCode).toHaveBeenCalledWith(
      expect.anything(),
      Buffer.from(ORIGINAL_CODE),
      "rev-9",
    );
    expect(lambda.waitForUpdate).toHaveBeenCalledOnce();
    expect(result.environment.changed).toBe(true);
    expect(await readSnapshot(await validateTarget(configPath))).toBeUndefined();
  });

  it("keeps the snapshot when the rollback fails", async () => {
    const configPath = await writeProjectConfig(false);
    const lambda = fakeLambda();
    const deps = { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) };
    await deployTarget({ configPath, logger: memoryLogger(), deps });
    vi.mocked(lambda.updateFunctionCode).mockRejectedValue(new LambdaDevError("aws_deploy", "x"));

    await expect(rollbackTarget({ configPath, logger: memoryLogger(), deps })).rejects.toThrow();
    expect(await readSnapshot(await validateTarget(configPath))).toBeDefined();
  });

  it("fails without AWS calls when there is no snapshot", async () => {
    const lambda = fakeLambda();

    await expect(
      rollbackTarget({
        configPath: await writeProjectConfig(false),
        logger: memoryLogger(),
        deps: { lambda },
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(lambda.restoreEnvironment).not.toHaveBeenCalled();
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
  });
});

async function checksConfig(): Promise<string> {
  const file = await writeProjectConfig(false);
  await writeFile(
    path.join(path.dirname(file), "health.json"),
    JSON.stringify({ path: "/health" }),
  );
  await writeFile(
    file,
    `${await readFile(file, "utf8")}    checks:
      health:
        payloadFile: health.json
        expect:
          payload: { ok: true }
      validation:
        payloadJson: { bad: true }
        expect:
          payload: { statusCode: 400 }
`,
  );

  return file;
}

describe("build command", () => {
  it("builds without calling AWS and honours --no-cache", async () => {
    const configPath = await writeProjectConfig(true);
    const lambda = fakeLambda();
    const buildArtifact = vi.fn().mockResolvedValue(built());

    const result = await buildTarget({
      configPath,
      cache: false,
      logger: memoryLogger(),
      deps: { buildArtifact, lambda },
    });

    expect(result.artifactPath).toBe("/tmp/function.zip");
    expect(buildArtifact.mock.calls[0]?.[0].target.build.cache).toBe(false);
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
    expect(lambda.downloadFunction).not.toHaveBeenCalled();
    expect(lambda.invokeFunction).not.toHaveBeenCalled();
  });
});

describe("checks", () => {
  it("runs every check with its own payload and reports the results", async () => {
    const configPath = await checksConfig();
    const lambda = fakeLambda();
    lambda.invokeFunction = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { ok: true, version: "1" } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { statusCode: 400 } });
    const logger = memoryLogger();

    const results = await checkTarget({ configPath, logger, deps: { lambda } });

    expect(results.map((result) => [result.name, result.mismatches])).toEqual([
      ["health", []],
      ["validation", []],
    ]);
    expect(vi.mocked(lambda.invokeFunction).mock.calls.map((call) => call[1])).toEqual([
      { path: "/health" },
      { bad: true },
    ]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("[dev] check: health passed"));
  });

  it("runs the remaining checks after a failure, then fails", async () => {
    const configPath = await checksConfig();
    const lambda = fakeLambda();
    lambda.invokeFunction = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { ok: false } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { statusCode: 400 } });
    const logger = memoryLogger();

    await expect(checkTarget({ configPath, logger, deps: { lambda } })).rejects.toMatchObject({
      category: "aws_invoke",
      message: expect.stringContaining("1 of 2 checks failed for dev-function: health"),
    });
    expect(lambda.invokeFunction).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      "[dev] check: health failed: payload.ok: expected true, received false",
    );
  });

  it("runs only the named checks and rejects unknown names before invoking", async () => {
    const configPath = await checksConfig();
    const lambda = fakeLambda();

    await checkTarget({ configPath, names: ["health"], logger: memoryLogger(), deps: { lambda } });
    expect(lambda.invokeFunction).toHaveBeenCalledOnce();

    await expect(
      checkTarget({ configPath, names: ["nope"], logger: memoryLogger(), deps: { lambda } }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(lambda.invokeFunction).toHaveBeenCalledOnce();
  });

  it("deploy --check runs the checks after the upload, and fails before building without checks", async () => {
    const lambda = fakeLambda();
    const buildArtifact = vi.fn().mockResolvedValue(built());
    lambda.invokeFunction = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { ok: true } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { statusCode: 400 } });

    const summary = await deployTarget({
      configPath: await checksConfig(),
      check: true,
      logger: memoryLogger(),
      deps: { buildArtifact, lambda },
    });

    expect(summary.checks?.map((result) => result.name)).toEqual(["health", "validation"]);
    expect(vi.mocked(lambda.updateFunctionCode).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(lambda.invokeFunction).mock.invocationCallOrder[0]!,
    );

    const noChecks = vi.fn();
    await expect(
      deployTarget({
        configPath: await writeProjectConfig(false),
        check: true,
        logger: memoryLogger(),
        deps: { buildArtifact: noChecks, lambda: fakeLambda() },
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(noChecks).not.toHaveBeenCalled();
  });
});

describe("invoke.expect", () => {
  async function expectConfig(): Promise<string> {
    const file = await writeProjectConfig(true);
    await writeFile(
      file,
      `${await readFile(file, "utf8")}      expect:
        payload: { ok: true }
`,
    );

    return file;
  }

  it("fails invoke when the response doesn't match, unless --no-expect", async () => {
    const configPath = await expectConfig();
    const lambda = fakeLambda();
    lambda.invokeFunction = vi.fn().mockResolvedValue({ statusCode: 200, payload: { ok: false } });

    await expect(
      invokeTarget({ configPath, logger: memoryLogger(), deps: { lambda } }),
    ).rejects.toMatchObject({
      category: "aws_invoke",
      message: expect.stringContaining("payload.ok: expected true, received false"),
    });

    await expect(
      invokeTarget({ configPath, expect: false, logger: memoryLogger(), deps: { lambda } }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it("checks the after-deploy invoke too", async () => {
    const configPath = await expectConfig();
    const logger = memoryLogger();

    await deployTarget({
      configPath,
      logger,
      deps: { buildArtifact: vi.fn().mockResolvedValue(built()), lambda: fakeLambda() },
    });

    expect(logger.info).toHaveBeenCalledWith("[dev] invoke: Response matches invoke.expect");
  });
});

describe("concurrent deploy guard", () => {
  it("uploads code against the revision left by the environment sync", async () => {
    const lambda = fakeLambda();
    lambda.updateEnvironment = vi
      .fn()
      .mockResolvedValue({ changed: true, updatedCount: 1, deletedCount: 0, revisionId: "rev-3" });

    await deployTarget({
      configPath: await environmentConfig(),
      invoke: false,
      logger: memoryLogger(),
      deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });

    expect(lambda.updateFunctionCode).toHaveBeenCalledWith(
      expect.anything(),
      built().artifactBytes,
      "rev-3",
    );
  });

  it("uploads code-only targets without a revision", async () => {
    const lambda = fakeLambda();

    await deployTarget({
      configPath: await writeProjectConfig(false),
      logger: memoryLogger(),
      deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });

    expect(lambda.updateFunctionCode).toHaveBeenCalledWith(
      expect.anything(),
      built().artifactBytes,
      undefined,
    );
  });
});

async function protectedConfig(): Promise<string> {
  const file = await writeProjectConfig(false);
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace("    build:", "    protected: true\n    build:"),
  );

  return file;
}

describe("protected targets", () => {
  it("asks before deploying and deploys on yes", async () => {
    const lambda = fakeLambda();
    const confirm = vi.fn().mockResolvedValue(true);

    await deployTarget({
      configPath: await protectedConfig(),
      logger: memoryLogger(),
      deps: { lambda, confirm, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });

    expect(confirm).toHaveBeenCalledWith(
      "Target dev is protected. Deploy to dev-function in eu-west-2?",
    );
    expect(lambda.updateFunctionCode).toHaveBeenCalledOnce();
  });

  it("stops before building when the answer is no, or there's no terminal", async () => {
    for (const answer of [false, undefined]) {
      const lambda = fakeLambda();
      const buildArtifact = vi.fn();

      await expect(
        deployTarget({
          configPath: await protectedConfig(),
          logger: memoryLogger(),
          deps: { lambda, buildArtifact, confirm: vi.fn().mockResolvedValue(answer) },
        }),
      ).rejects.toMatchObject({
        category: "validation",
        hint:
          answer === undefined ? expect.stringContaining("--yes") : "Nothing was changed in AWS.",
      });
      expect(buildArtifact).not.toHaveBeenCalled();
      expect(lambda.downloadFunction).not.toHaveBeenCalled();
      expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
    }
  });

  it("skips the question with --yes, and never asks for unprotected targets", async () => {
    const confirm = vi.fn();

    const deps = {
      confirm,
      lambda: fakeLambda(),
      buildArtifact: vi.fn().mockResolvedValue(built()),
    };

    await deployTarget({
      configPath: await protectedConfig(),
      yes: true,
      logger: memoryLogger(),
      deps,
    });
    await deployTarget({
      configPath: await writeProjectConfig(false),
      logger: memoryLogger(),
      deps,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(deps.lambda.updateFunctionCode).toHaveBeenCalledTimes(2);
  });

  it("refuses deploys from watch even with --yes", async () => {
    const confirm = vi.fn();
    const buildArtifact = vi.fn();

    await expect(
      deployTarget({
        configPath: await protectedConfig(),
        fromWatch: true,
        yes: true,
        logger: memoryLogger(),
        deps: { confirm, buildArtifact, lambda: fakeLambda() },
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(confirm).not.toHaveBeenCalled();
    expect(buildArtifact).not.toHaveBeenCalled();
  });

  it("asks before rolling back", async () => {
    const configPath = await protectedConfig();
    const lambda = fakeLambda();
    const buildArtifact = vi.fn().mockResolvedValue(built());
    await deployTarget({
      configPath,
      yes: true,
      logger: memoryLogger(),
      deps: { lambda, buildArtifact },
    });

    await expect(
      rollbackTarget({
        configPath,
        logger: memoryLogger(),
        deps: { lambda, confirm: vi.fn().mockResolvedValue(false) },
      }),
    ).rejects.toMatchObject({ message: "Cancelled the rollback to dev" });
    expect(lambda.restoreEnvironment).not.toHaveBeenCalled();

    await rollbackTarget({ configPath, yes: true, logger: memoryLogger(), deps: { lambda } });
    expect(lambda.restoreEnvironment).toHaveBeenCalledOnce();
  });
});

describe("zip size", () => {
  const MB = 1024 * 1024;

  it("warns when the zip is close to the 50 MB direct upload limit", async () => {
    const logger = memoryLogger();

    await buildTarget({
      configPath: await writeProjectConfig(false),
      logger,
      deps: { buildArtifact: vi.fn().mockResolvedValue({ ...built(), sizeBytes: 45 * MB }) },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[dev\] build: The zip is 45\.0 MB, close to Lambda's 50\.0 MB limit/,
      ),
    );
  });

  it("doesn't warn for small zips", async () => {
    const logger = memoryLogger();

    await buildTarget({
      configPath: await writeProjectConfig(false),
      logger,
      deps: { buildArtifact: vi.fn().mockResolvedValue({ ...built(), sizeBytes: 39 * MB }) },
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails a deploy over the limit before changing AWS", async () => {
    const lambda = fakeLambda();

    await expect(
      deployTarget({
        configPath: await writeProjectConfig(true),
        logger: memoryLogger(),
        deps: {
          lambda,
          buildArtifact: vi.fn().mockResolvedValue({ ...built(), sizeBytes: 51 * MB }),
        },
      }),
    ).rejects.toMatchObject({ category: "build", message: expect.stringContaining("51.0 MB") });
    expect(lambda.downloadFunction).not.toHaveBeenCalled();
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
  });
});

describe("rollback when checks fail", () => {
  const PREVIOUS = {
    code: new Uint8Array([7, 7]),
    codeSha256: sha256Base64(new Uint8Array([7, 7])),
    environment: { PREVIOUS: "FAKE_PREVIOUS_VALUE" },
  };

  /** A target that has been deployed before, so the snapshot already exists. */
  async function deployedChecksConfig(lambda: LambdaAdapter): Promise<string> {
    const configPath = await checksConfig();
    await deployTarget({
      configPath,
      logger: memoryLogger(),
      deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });
    vi.mocked(lambda.updateFunctionCode).mockClear();
    vi.mocked(lambda.downloadFunction).mockClear().mockResolvedValue(PREVIOUS);

    return configPath;
  }

  const failingHealth = () =>
    vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, payload: { ok: false } })
      .mockResolvedValueOnce({ statusCode: 200, payload: { statusCode: 400 } });

  it("puts back the code from before this deploy", async () => {
    const lambda = fakeLambda();
    const configPath = await deployedChecksConfig(lambda);
    lambda.invokeFunction = failingHealth();
    const logger = memoryLogger();

    await expect(
      deployTarget({
        configPath,
        check: true,
        logger,
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({
      category: "aws_invoke",
      message: expect.stringContaining("1 of 2 checks failed"),
      hint: expect.stringContaining("Rolled back"),
    });

    // The state is read before the upload, then its code is uploaded again after the failure.
    expect(vi.mocked(lambda.downloadFunction).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(lambda.updateFunctionCode).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(lambda.updateFunctionCode).mock.calls.map((call) => call[1])).toEqual([
      built().artifactBytes,
      PREVIOUS.code,
    ]);
    expect(lambda.restoreEnvironment).not.toHaveBeenCalled();
    expect(lambda.waitForUpdate).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[dev] rollback: Checks failed; restoring the code from before this deploy",
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("FAKE_PREVIOUS_VALUE");
  });

  it("uses the snapshot on a first deploy instead of reading the function twice", async () => {
    const lambda = fakeLambda();
    lambda.invokeFunction = failingHealth();

    await expect(
      deployTarget({
        configPath: await checksConfig(),
        check: true,
        logger: memoryLogger(),
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("Rolled back") });

    expect(lambda.downloadFunction).toHaveBeenCalledOnce();
    expect(vi.mocked(lambda.updateFunctionCode).mock.calls[1]?.[1]).toEqual(ORIGINAL_CODE);
  });

  it("restores the environment too when the deploy changed it, chaining the revision", async () => {
    const lambda = fakeLambda();
    const configPath = await checksConfig();
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "    build:",
        "    environment: { LOG_LEVEL: debug }\n    build:",
      ),
    );
    lambda.updateEnvironment = vi
      .fn()
      .mockResolvedValue({ changed: true, updatedCount: 1, deletedCount: 0, revisionId: "rev-1" });
    lambda.invokeFunction = failingHealth();

    await expect(
      deployTarget({
        configPath,
        check: true,
        logger: memoryLogger(),
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("Rolled back") });

    expect(lambda.restoreEnvironment).toHaveBeenCalledWith(expect.anything(), {
      ORIGINAL: "FAKE_SNAPSHOT_VALUE",
    });
    expect(vi.mocked(lambda.updateFunctionCode).mock.calls[1]).toEqual([
      expect.anything(),
      ORIGINAL_CODE,
      "rev-9",
    ]);
  });

  it("rolls back when invoke.expect fails after a deploy", async () => {
    const lambda = fakeLambda();
    const configPath = await writeProjectConfig(true);
    await writeFile(
      configPath,
      `${await readFile(configPath, "utf8")}      expect:\n        payload: { ok: true }\n`,
    );
    lambda.invokeFunction = vi.fn().mockResolvedValue({ statusCode: 200, payload: { ok: false } });

    await expect(
      deployTarget({
        configPath,
        logger: memoryLogger(),
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("Rolled back") });
    expect(lambda.updateFunctionCode).toHaveBeenCalledTimes(2);
  });

  it("keeps the new code with --no-rollback or rollbackOnFailure: false", async () => {
    for (const [rollback, config] of [
      [false, ""],
      [undefined, "    rollbackOnFailure: false\n"],
    ] as const) {
      const lambda = fakeLambda();
      const configPath = await deployedChecksConfig(lambda);
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace("    build:", `${config}    build:`),
      );
      lambda.invokeFunction = failingHealth();

      await expect(
        deployTarget({
          configPath,
          check: true,
          rollback,
          logger: memoryLogger(),
          deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
        }),
      ).rejects.toMatchObject({ hint: expect.stringContaining("The new code is still deployed") });
      expect(lambda.downloadFunction).not.toHaveBeenCalled();
      expect(lambda.updateFunctionCode).toHaveBeenCalledOnce();
    }
  });

  it("doesn't roll back when invoking itself fails, or from watch", async () => {
    const lambda = fakeLambda();
    const configPath = await deployedChecksConfig(lambda);
    lambda.invokeFunction = vi
      .fn()
      .mockRejectedValue(new LambdaDevError("aws_invoke", "Failed to invoke dev-function"));

    await expect(
      deployTarget({
        configPath,
        check: true,
        logger: memoryLogger(),
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({ message: "Failed to invoke dev-function" });
    expect(lambda.updateFunctionCode).toHaveBeenCalledOnce();

    vi.mocked(lambda.downloadFunction).mockClear();
    lambda.invokeFunction = failingHealth();
    await expect(
      deployTarget({
        configPath,
        check: true,
        fromWatch: true,
        logger: memoryLogger(),
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("still deployed") });
    expect(lambda.downloadFunction).not.toHaveBeenCalled();
  });

  it("says so when the rollback itself fails", async () => {
    const lambda = fakeLambda();
    const configPath = await deployedChecksConfig(lambda);
    lambda.invokeFunction = failingHealth();
    vi.mocked(lambda.updateFunctionCode)
      .mockResolvedValueOnce({ functionName: "dev-function" })
      .mockRejectedValueOnce(new LambdaDevError("aws_deploy", "Failed to upload dev-function"));

    await expect(
      deployTarget({
        configPath,
        check: true,
        logger: memoryLogger(),
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({
      category: "aws_deploy",
      message: expect.stringContaining("and rolling back failed: Failed to upload dev-function"),
      hint: expect.stringContaining("may still be deployed"),
    });
  });

  it("doesn't read the function when nothing will be checked", async () => {
    const lambda = fakeLambda();
    const configPath = await deployedChecksConfig(lambda);

    await deployTarget({
      configPath,
      logger: memoryLogger(),
      deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
    });
    expect(lambda.downloadFunction).not.toHaveBeenCalled();
  });

  it("stops before changing anything when the current state can't be read", async () => {
    const lambda = fakeLambda();
    const configPath = await deployedChecksConfig(lambda);
    vi.mocked(lambda.downloadFunction).mockRejectedValue(
      new LambdaDevError("aws_snapshot", "Failed to save the function's current code for rollback"),
    );

    await expect(
      deployTarget({
        configPath,
        check: true,
        logger: memoryLogger(),
        deps: { lambda, buildArtifact: vi.fn().mockResolvedValue(built()) },
      }),
    ).rejects.toMatchObject({
      category: "aws_snapshot",
      hint: expect.stringContaining("--no-rollback"),
    });
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
  });
});
