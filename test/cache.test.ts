import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { buildArtifact } from "../src/build.js";
import { buildCacheRoot } from "../src/cache.js";
import { loadTarget } from "../src/config.js";
import { LambdaDevError } from "../src/errors.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(targets: string): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lambda-dev-cache-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "src/handler.ts"),
    'import { value } from "./value";\nexport const handler = () => value;\n',
  );
  await writeFile(path.join(root, "src/value.ts"), 'export const value = "one";\n');
  await writeFile(path.join(root, "assets/data.txt"), "data");
  await writeFile(path.join(root, "package.json"), "{}\n");
  const configPath = path.join(root, "lambda-dev.yml");
  await writeFile(
    configPath,
    `version: 1
targets:
${targets}`,
  );

  return { root, configPath };
}

const sharedTargets = (extra = "") => `  dev:
    functionName: dev
    region: eu-west-2
    build: &build
      entry: src/handler.ts
      copy:
        - from: assets
          to: assets
${extra}
  prod:
    functionName: prod
    region: eu-west-2
    build: *build
`;

describe("build cache", () => {
  it("reuses the same zip bytes for another target with the same build", async () => {
    const { configPath } = await project(sharedTargets());
    const dev = await buildArtifact(await loadTarget(configPath, "dev"));
    const prod = await buildArtifact(await loadTarget(configPath, "prod"));

    expect(dev.cached).toBe(false);
    expect(prod.cached).toBe(true);
    expect(Buffer.from(prod.artifactBytes)).toEqual(Buffer.from(dev.artifactBytes));
    expect(prod.artifactPath).toContain(path.join(".lambda-dev", "prod"));

    // The output directory looks the same as after a fresh build.
    const output = path.dirname(prod.artifactPath);
    expect(await readFile(path.join(output, "index.js"), "utf8")).toContain('"one"');
    expect(await readFile(path.join(output, "assets/data.txt"), "utf8")).toBe("data");
    expect(await readFile(prod.artifactPath)).toEqual(Buffer.from(dev.artifactBytes));
  });

  it("rebuilds when a bundled file, a copied file, or a lockfile changes", async () => {
    const { root, configPath } = await project(sharedTargets());
    const loaded = await loadTarget(configPath, "dev");
    await buildArtifact(loaded);

    await writeFile(path.join(root, "src/value.ts"), 'export const value = "two";\n');
    const afterSource = await buildArtifact(loaded);
    expect(afterSource.cached).toBe(false);
    expect(new AdmZip(Buffer.from(afterSource.artifactBytes)).readAsText("index.js")).toContain(
      '"two"',
    );
    expect((await buildArtifact(loaded)).cached).toBe(true);

    await writeFile(path.join(root, "assets/data.txt"), "changed");
    expect((await buildArtifact(loaded)).cached).toBe(false);
    expect((await buildArtifact(loaded)).cached).toBe(true);

    await writeFile(path.join(root, "bun.lock"), "{}\n");
    expect((await buildArtifact(loaded)).cached).toBe(false);
  });

  it("keeps targets with different build options apart", async () => {
    const { configPath } = await project(`  dev:
    functionName: dev
    region: eu-west-2
    build:
      entry: src/handler.ts
      define:
        process.env.STAGE: '"dev"'
  prod:
    functionName: prod
    region: eu-west-2
    build:
      entry: src/handler.ts
      define:
        process.env.STAGE: '"prod"'
`);

    await buildArtifact(await loadTarget(configPath, "dev"));
    expect((await buildArtifact(await loadTarget(configPath, "prod"))).cached).toBe(false);
  });

  it("rebuilds when the cached zip doesn't match its checksum", async () => {
    const { root, configPath } = await project(sharedTargets());
    await buildArtifact(await loadTarget(configPath, "dev"));
    const cacheRoot = buildCacheRoot(root);
    const [entry] = await readdir(cacheRoot);
    await writeFile(path.join(cacheRoot, entry!, "function.zip"), "corrupt");

    const prod = await buildArtifact(await loadTarget(configPath, "prod"));
    expect(prod.cached).toBe(false);
    expect(new AdmZip(Buffer.from(prod.artifactBytes)).getEntry("index.js")).toBeTruthy();
  });

  it("doesn't read or write the cache when build.cache is false", async () => {
    const { root, configPath } = await project(sharedTargets("      cache: false"));
    await buildArtifact(await loadTarget(configPath, "dev"));
    expect((await buildArtifact(await loadTarget(configPath, "prod"))).cached).toBe(false);
    await expect(stat(buildCacheRoot(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an outDir that would delete the cache", async () => {
    const { configPath } = await project(`  dev:
    functionName: dev
    region: eu-west-2
    build:
      entry: src/handler.ts
      outDir: .lambda-dev
`);

    const error = await buildArtifact(await loadTarget(configPath, "dev")).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(LambdaDevError);
    expect(error).toMatchObject({ category: "validation" });
  });
});
