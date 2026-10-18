import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
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
      .mockResolvedValue({ changed: true, updatedCount: 1, deletedCount: 1 }),
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
