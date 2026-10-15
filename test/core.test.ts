import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deployTarget, formatInvokeSummary, invokeTarget } from "../src/core.js";
import type { LambdaAdapter } from "../src/aws.js";

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
    await fs.writeFile(configPath, contents.replace("entry: src/handler.ts", "entry: src/handler.ts\n      copy: [{ from: missing-runtime.bin, to: bin/helper }]"));
    const lambda = fakeLambda();
    await expect(deployTarget({ configPath, logger: memoryLogger(), deps: { lambda } })).rejects.toMatchObject({ category: "build" });
    expect(lambda.updateFunctionCode).not.toHaveBeenCalled();
    expect(lambda.invokeFunction).not.toHaveBeenCalled();
  });

  it("formats invoke results with key fields", () => {
    expect(
      formatInvokeSummary({ statusCode: 200, functionError: "Unhandled", payload: { ok: false } }),
    ).toContain("functionError Unhandled");
  });
});

function fakeLambda(): LambdaAdapter {
  return {
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
