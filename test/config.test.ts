import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadTarget } from "../src/config.js";
import { LambdaDevError } from "../src/errors.js";

describe("config", () => {
  it("loads a valid config and applies defaults", async () => {
    const configPath = await writeConfig(validConfig());
    const loaded = await loadTarget(configPath);

    expect(loaded.targetName).toBe("dev");
    expect(loaded.target.build.copy).toEqual([]);
    expect(loaded.target.build.outDir).toBe(path.join(".lambda-dev", "dev"));
    expect(loaded.target.watch.debounceMs).toBe(300);
    expect(loaded.target.invoke.logType).toBe("Tail");
  });

  it("selects a named target", async () => {
    const configPath = await writeConfig(`${validConfig()}
  staging:
    functionName: staging-function
    region: us-east-1
    build:
      entry: src/staging.ts
`);

    const loaded = await loadTarget(configPath, "staging");
    expect(loaded.target.functionName).toBe("staging-function");
  });

  it("rejects invalid YAML", async () => {
    const configPath = await writeConfig("version: [");
    await expect(loadConfig(configPath)).rejects.toMatchObject({ category: "validation" });
  });

  it("rejects missing required fields before AWS calls can happen", async () => {
    const configPath = await writeConfig(`version: 1
targets:
  dev:
    region: eu-west-2
    build:
      entry: src/handler.ts
`);

    await expect(loadTarget(configPath, "dev")).rejects.toBeInstanceOf(LambdaDevError);
    await expect(loadTarget(configPath, "dev")).rejects.toMatchObject({ category: "validation" });
  });

  it("rejects unknown targets with available names", async () => {
    const configPath = await writeConfig(validConfig());
    await expect(loadTarget(configPath, "missing")).rejects.toThrow("Available targets: dev");
  });
  it("resolves anchored builds, copy lists, mapping merges, and explicit overrides", async () => {
    const configPath = await writeConfig(`version: 1
targets:
  dev: &dev
    functionName: dev-function
    region: eu-west-2
    build: &build
      entry: handler.ts
      minify: false
      copy: &assets
        - from: assets
          to: runtime
  staging:
    <<: *dev
    functionName: staging-function
    build:
      <<: [*build, { entry: other.ts, minify: true, sourcemap: false }]
      minify: true
      copy: *assets
  alias:
    <<: *dev
    build: *build
`);
    const config = await loadConfig(configPath);
    expect(config.targets.staging.build).toMatchObject({
      entry: "handler.ts", minify: true, sourcemap: false, copy: [{ from: "assets", to: "runtime" }],
    });
    expect(config.targets.dev.build.minify).toBe(false);
    expect(config.targets.dev.build.sourcemap).toBe(true);
    expect(config.targets.alias.build).toEqual(config.targets.dev.build);
  });

  it.each([
    "[{ from: '', to: data }]", "[{ from: data, to: '' }]", "[{ from: '   ', to: data }]",
    "[{ from: 42, to: data }]", "[{ from: data }]", "[{ from: data, to: dest, unknown: true }]", "false",
  ])("rejects malformed copy config %s", async (copy) => {
    const configPath = await writeConfig(`${validConfig()}      copy: ${copy}\n`);
    await expect(loadConfig(configPath)).rejects.toMatchObject({ category: "validation" });
  });

  it.each(["build: *missing", "build: { <<: 42, entry: handler.ts }"])("rejects invalid YAML references: %s", async (value) => {
    const configPath = await writeConfig(`version: 1\ntargets:\n  dev:\n    functionName: test\n    region: eu-west-2\n    ${value}\n`);
    await expect(loadConfig(configPath)).rejects.toMatchObject({ category: "validation", message: expect.stringContaining("Invalid YAML") });
  });

  it("uses shallow merges rather than implicitly merging nested build mappings", async () => {
    const configPath = await writeConfig(`version: 1
targets:
  dev: &dev
    functionName: dev
    region: eu-west-2
    build:
      entry: handler.ts
  staging:
    <<: *dev
    build:
      minify: true
`);
    await expect(loadConfig(configPath)).rejects.toMatchObject({
      category: "validation", message: expect.stringContaining("targets.staging.build.entry"),
    });
  });

  it("preserves the alias expansion limit", async () => {
    let yaml = "base: &base [hello]\n";
    let previous = "base";
    for (let i = 0; i < 5; i++) {
      yaml += `level${i}: &level${i} [${Array(10).fill(`*${previous}`).join(", ")}]\n`;
      previous = `level${i}`;
    }
    const configPath = await writeConfig(yaml);
    await expect(loadConfig(configPath)).rejects.toMatchObject({ category: "validation", message: expect.stringContaining("alias") });
  });

  it("keeps schema validation strict after merging", async () => {
    const configPath = await writeConfig(`${validConfig()}      <<: { surprise: true }\n`);
    await expect(loadConfig(configPath)).rejects.toMatchObject({ category: "validation", message: expect.stringContaining("surprise") });
  });

});

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lambda-dev-config-"));
  const configPath = path.join(dir, "lambda-dev.yml");
  await writeFile(configPath, contents);
  return configPath;
}

function validConfig(): string {
  return `version: 1
defaultTarget: dev
targets:
  dev:
    functionName: dev-function
    region: eu-west-2
    build:
      entry: src/handler.ts
`;
}
