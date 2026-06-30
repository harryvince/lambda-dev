import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";

describe("cli", () => {
  it("validates a configured target", async () => {
    const configPath = await writeConfig();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = createProgram();

    await program.parseAsync(["node", "aws-lambda-dev", "validate", "dev", "--config", configPath]);

    expect(output).toHaveBeenCalledWith("[dev] validation: ok");
  });

  it("exposes only the aws-lambda-dev package bin", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { bin: Record<string, string> };

    expect(packageJson.bin).toEqual({ "aws-lambda-dev": "dist/cli.js" });
    expect(packageJson.bin).not.toHaveProperty("lambda-dev");
  });

  it("prints help through the compiled package bin", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    await execFileAsync("bun", ["run", "build"]);
    const { stdout } = await execFileAsync("node", ["dist/cli.js", "--help"]);

    expect(stdout).toContain("Usage: aws-lambda-dev");
    expect(stdout).toContain("Hot-reload, deploy, and invoke existing AWS Lambda functions.");
    expect(stdout).toContain("watch");
  });
});

async function writeConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lambda-dev-cli-"));
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
`
  );
  return configPath;
}
