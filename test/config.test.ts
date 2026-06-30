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
