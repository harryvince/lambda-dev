import { writeFile } from "node:fs/promises";
import path from "node:path";

export const starterConfig = `version: 1
defaultTarget: dev
targets:
  dev:
    functionName: my-existing-lambda-dev
    region: eu-west-2
    build:
      entry: src/handler.ts
      bundle: true
      platform: node
      target: node20
      format: cjs
      sourcemap: true
      external:
        - "@aws-sdk/*"
    watch:
      include:
        - src/**/*.ts
      exclude:
        - dist/**
        - node_modules/**
        - .lambda-dev/**
      debounceMs: 300
    invoke:
      afterDeploy: true
      payloadFile: events/dev.json
`;

export async function writeStarterConfig(configPath = "lambda-dev.yml"): Promise<string> {
  const outputPath = path.resolve(configPath);
  await writeFile(outputPath, starterConfig, { flag: "wx" });
  return outputPath;
}
