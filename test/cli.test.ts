import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";

describe("cli", () => {
  it("validates a configured target", async () => {
    const configPath = await writeConfig();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = createProgram();

    await program.parseAsync(["node", "lambda-dev", "validate", "dev", "--config", configPath]);

    expect(output).toHaveBeenCalledWith("[dev] validation: ok");
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
