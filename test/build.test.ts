import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildArtifact } from "../src/build.js";
import type { LoadedTarget } from "../src/config.js";

describe("buildArtifact", () => {
  it("bundles a handler and creates a zip artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lambda-dev-build-"));
    await writeFile(path.join(root, "handler.ts"), "export const handler = async () => ({ ok: true });");

    const result = await buildArtifact({
      configPath: path.join(root, "lambda-dev.yml"),
      projectRoot: root,
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
          outDir: ".lambda-dev/dev"
        },
        watch: { include: ["*.ts"], exclude: [], debounceMs: 300 },
        invoke: { afterDeploy: false, logType: "Tail" }
      }
    } satisfies LoadedTarget);

    expect(result.sizeBytes).toBeGreaterThan(0);
    const zip = new AdmZip(result.artifactPath);
    expect(zip.getEntry("index.js")).toBeTruthy();
  });
});
