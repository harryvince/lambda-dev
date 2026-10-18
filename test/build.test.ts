import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildArtifact } from "../src/build.js";
import { loadTarget, type LoadedTarget } from "../src/config.js";

describe("buildArtifact", () => {
  it("bundles a handler and creates a zip artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lambda-dev-build-"));
    await writeFile(
      path.join(root, "handler.ts"),
      "export const handler = async () => ({ ok: true });",
    );

    const result = await buildArtifact({
      configPath: path.join(root, "lambda-dev.yml"),
      projectRoot: root,
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
          outDir: ".lambda-dev/dev",
        },
        watch: { include: ["*.ts"], exclude: [], debounceMs: 300 },
        invoke: { afterDeploy: false, logType: "Tail" },
      },
    } satisfies LoadedTarget);

    expect(result.sizeBytes).toBeGreaterThan(0);
    const zip = new AdmZip(result.artifactPath);
    expect(zip.getEntry("index.js")).toBeTruthy();
  });
});

describe("copy build integration", () => {
  it("packages YAML-anchored runtime assets with binary bytes and executable permissions, and cleans stale assets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lambda-runtime-"));

    try {
      await mkdir(path.join(root, "assets/nested"), { recursive: true });
      await mkdir(path.join(root, "assets/empty"));
      const binary = Buffer.from([0, 255, 128, 10]);
      await writeFile(path.join(root, "assets/helper"), binary);
      await chmod(path.join(root, "assets/helper"), 0o755);
      await writeFile(path.join(root, "assets/nested/value.txt"), "runtime loaded");
      await writeFile(
        path.join(root, "handler.ts"),
        `
        import { readFileSync } from "node:fs";
        import path from "node:path";
        export const handler = () => readFileSync(path.join(__dirname, "runtime/nested/value.txt"), "utf8");
      `,
      );
      const configPath = path.join(root, "lambda-dev.yml");
      await writeFile(
        configPath,
        `version: 1
targets:
  dev:
    functionName: dev
    region: eu-west-2
    build: &build
      entry: handler.ts
      copy: &copy
        - from: assets
          to: runtime
  staging:
    functionName: staging
    region: eu-west-2
    build:
      <<: *build
      minify: true
      copy: *copy
`,
      );
      const loaded = await loadTarget(configPath, "staging");
      const result = await buildArtifact(loaded);
      const zip = new AdmZip(result.artifactPath);
      expect(zip.getEntry("index.js.map")).toBeTruthy();
      expect(zip.getEntry("runtime/empty/")?.isDirectory).toBe(true);
      const helper = zip.getEntry("runtime/helper")!;
      expect(helper.getData()).toEqual(binary);
      expect((helper.attr >>> 16) & 0o777).toBe(0o755);
      const output = path.dirname(result.artifactPath);
      expect((await stat(path.join(output, "runtime/helper"))).mode & 0o777).toBe(0o755);
      expect(await readFile(path.join(output, "runtime/helper"))).toEqual(binary);
      expect(zip.getEntry("function.zip")).toBeNull();

      // Execute the actual packaged handler from a fresh extraction directory.
      const extracted = path.join(root, "extracted");
      zip.extractAllTo(extracted);
      const require = createRequire(import.meta.url);
      expect(require(path.join(extracted, "index.js")).handler()).toBe("runtime loaded");

      await rm(path.join(root, "assets/helper"));
      const rebuilt = await buildArtifact(loaded);
      expect(new AdmZip(rebuilt.artifactPath).getEntry("runtime/helper")).toBeNull();
      await expect(stat(path.join(output, "runtime/helper"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
