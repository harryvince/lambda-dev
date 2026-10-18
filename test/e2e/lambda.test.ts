import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  waitUntilFunctionActiveV2,
} from "@aws-sdk/client-lambda";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkTarget, deployTarget, invokeTarget, rollbackTarget } from "../../src/core.js";
import { AwsLambdaAdapter } from "../../src/aws.js";
import { readSnapshot } from "../../src/snapshot.js";
import { validateTarget } from "../../src/core.js";

// These tests talk to a local AWS emulator. Run them with `mise run test:e2e`, which starts one.
const endpoint = process.env.AWS_ENDPOINT_URL ?? "";

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(endpoint)) {
  throw new Error("AWS_ENDPOINT_URL must point at a local emulator; refusing to run against AWS.");
}

const region = "eu-west-2";
const functionName = `lambda-dev-e2e-${randomUUID().slice(0, 8)}`;
const client = new LambdaClient({ region });

const ORIGINAL_HANDLER = `exports.handler = async () => ({
  version: "original",
  flag: process.env.FLAG ?? null,
  keep: process.env.KEEP ?? null,
});
`;

const DEV_HANDLER = `export const handler = async (event: { name?: string }) => ({
  version: "dev",
  name: event.name ?? null,
  flag: process.env.FLAG ?? null,
  keep: process.env.KEEP ?? null,
});
`;

let configPath: string;

beforeAll(async () => {
  const original = new AdmZip();
  original.addFile("index.js", Buffer.from(ORIGINAL_HANDLER));

  await client.send(
    new CreateFunctionCommand({
      FunctionName: functionName,
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: "arn:aws:iam::000000000000:role/lambda-dev-e2e",
      Code: { ZipFile: original.toBuffer() },
      Environment: { Variables: { KEEP: "kept", FLAG: "original" } },
    }),
  );
  await waitUntilFunctionActiveV2({ client, maxWaitTime: 60 }, { FunctionName: functionName });

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "lambda-dev-e2e-"));
  await mkdir(path.join(projectRoot, "src"));
  await writeFile(path.join(projectRoot, "src", "handler.ts"), DEV_HANDLER);
  configPath = path.join(projectRoot, "lambda-dev.yml");
  await writeFile(
    configPath,
    `version: 1
targets:
  dev:
    functionName: ${functionName}
    region: ${region}
    environment:
      FLAG: dev
      ADDED: added
    build:
      entry: src/handler.ts
      target: node22
    invoke:
      payloadJson: { name: e2e }
    checks:
      dev-code:
        payloadJson: { name: check }
        expect:
          payload: { version: dev, name: check }
      original-code:
        expect:
          payload: { version: original }
`,
  );
});

afterAll(async () => {
  await client.send(new DeleteFunctionCommand({ FunctionName: functionName }));
});

describe("against a local Lambda emulator", () => {
  it("deploys, syncs the environment, and invokes the new code", async () => {
    const summary = await deployTarget({ configPath, invoke: true, logger: memoryLogger() });

    expect(summary.environment).toEqual({
      changed: true,
      updatedCount: 2,
      deletedCount: 0,
      revisionId: expect.any(String),
    });
    expect(summary.invoke?.statusCode).toBe(200);
    expect(summary.invoke?.payload).toEqual({
      version: "dev",
      name: "e2e",
      flag: "dev",
      keep: "kept",
    });
    expect(await environment()).toEqual({ KEEP: "kept", FLAG: "dev", ADDED: "added" });
  });

  it("snapshotted the function as it was before the first deploy", async () => {
    const snapshot = await readSnapshot(await validateTarget(configPath));

    expect(snapshot?.environment).toEqual({ KEEP: "kept", FLAG: "original" });
    expect(new AdmZip(Buffer.from(snapshot?.code ?? [])).readAsText("index.js")).toBe(
      ORIGINAL_HANDLER,
    );
  });

  it("keeps the first snapshot across later deploys", async () => {
    await deployTarget({ configPath, logger: memoryLogger() });

    const snapshot = await readSnapshot(await validateTarget(configPath));
    expect(snapshot?.environment).toEqual({ KEEP: "kept", FLAG: "original" });
  });

  it("refuses a code upload against a stale revision", async () => {
    const loaded = await validateTarget(configPath);

    await expect(
      new AwsLambdaAdapter().updateFunctionCode(loaded, new Uint8Array([1]), "stale-revision"),
    ).rejects.toMatchObject({
      category: "aws_deploy",
      message: expect.stringContaining("PreconditionFailedException"),
    });
  });

  it("passes checks that match the deployed code and fails the rest", async () => {
    const [result] = await checkTarget({
      configPath,
      names: ["dev-code"],
      logger: memoryLogger(),
    });

    expect(result?.mismatches).toEqual([]);

    await expect(
      checkTarget({ configPath, names: ["original-code"], logger: memoryLogger() }),
    ).rejects.toMatchObject({ category: "aws_invoke" });
  });

  it("puts back the previous code when a deploy's checks fail", async () => {
    const handler = path.join(path.dirname(configPath), "src", "handler.ts");
    await writeFile(handler, DEV_HANDLER.replace('version: "dev"', 'version: "broken"'));

    try {
      await expect(
        deployTarget({ configPath, check: true, logger: memoryLogger() }),
      ).rejects.toMatchObject({
        category: "aws_invoke",
        hint: expect.stringContaining("Rolled back"),
      });
    } finally {
      await writeFile(handler, DEV_HANDLER);
    }

    const invoked = await invokeTarget({ configPath, logger: memoryLogger() });
    expect(invoked.payload).toMatchObject({ version: "dev", flag: "dev" });
  });

  it("rolls back the code and environment, then deletes the snapshot", async () => {
    const summary = await rollbackTarget({ configPath, logger: memoryLogger() });

    expect(summary.environment).toEqual({
      changed: true,
      updatedCount: 1,
      deletedCount: 1,
      revisionId: expect.any(String),
    });
    expect(await environment()).toEqual({ KEEP: "kept", FLAG: "original" });

    const invoked = await invokeTarget({ configPath, logger: memoryLogger() });
    expect(invoked.payload).toEqual({ version: "original", flag: "original", keep: "kept" });
    expect(await readSnapshot(await validateTarget(configPath))).toBeUndefined();
    await checkTarget({ configPath, names: ["original-code"], logger: memoryLogger() });
  });
});

async function environment() {
  const configuration = await client.send(
    new GetFunctionConfigurationCommand({ FunctionName: functionName }),
  );

  return configuration.Environment?.Variables ?? {};
}

function memoryLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
