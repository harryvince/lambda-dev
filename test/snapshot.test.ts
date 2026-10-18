import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedTarget } from "../src/config.js";
import {
  hasSnapshot,
  readSnapshot,
  sha256Base64,
  snapshotDirectory,
  writeSnapshot,
} from "../src/snapshot.js";

describe("snapshot store", () => {
  it("round-trips a snapshot", async () => {
    const loaded = await target("dev-function");
    const code = new Uint8Array([1, 2, 3]);
    expect(await hasSnapshot(loaded)).toBe(false);

    await writeSnapshot(
      loaded,
      { code, codeSha256: sha256Base64(code), environment: { A: "1" } },
      new Date("2026-01-02T03:04:05Z"),
    );

    expect(await hasSnapshot(loaded)).toBe(true);
    expect(await readSnapshot(loaded)).toMatchObject({
      functionName: "dev-function",
      region: "eu-west-2",
      createdAt: "2026-01-02T03:04:05.000Z",
      environment: { A: "1" },
    });
  });

  it("rejects a snapshot whose code no longer matches its checksum", async () => {
    const loaded = await target("dev-function");
    const code = new Uint8Array([1]);

    const directory = await writeSnapshot(loaded, {
      code,
      codeSha256: sha256Base64(code),
      environment: {},
    });

    await writeFile(path.join(directory, "code.zip"), "tampered");

    await expect(readSnapshot(loaded)).rejects.toMatchObject({ category: "filesystem" });
  });

  it("keeps ARNs and odd names inside the snapshots directory", async () => {
    const arn = await target("arn:aws:lambda:eu-west-2:123456789012:function:dev");
    const dots = await target("..");
    const root = path.join(arn.projectRoot, ".lambda-dev", "snapshots", "eu-west-2");

    expect(snapshotDirectory(arn)).toBe(
      path.join(root, "arn_aws_lambda_eu-west-2_123456789012_function_dev"),
    );
    expect(path.dirname(snapshotDirectory(dots))).toBe(
      path.join(dots.projectRoot, ".lambda-dev", "snapshots", "eu-west-2"),
    );
  });
});

async function target(functionName: string): Promise<LoadedTarget> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "lambda-dev-snapshot-"));

  return {
    configPath: path.join(projectRoot, "lambda-dev.yml"),
    projectRoot,
    targetName: "dev",
    target: {
      functionName,
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
      watch: { include: [], exclude: [], debounceMs: 300 },
      invoke: { afterDeploy: false, logType: "Tail" },
      checks: {},
    },
  };
}
