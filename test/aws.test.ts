import { TextEncoder } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { InvokeCommand, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda";
import { AwsLambdaAdapter, createLambdaClient } from "../src/aws.js";
import type { LoadedTarget } from "../src/config.js";

describe("aws adapter", () => {
  it("updates Lambda function code with zip bytes", async () => {
    const send = vi.fn().mockResolvedValue({ Version: "7", $metadata: { requestId: "req-1" } });
    const adapter = new AwsLambdaAdapter(() => ({ send }) as never);
    const result = await adapter.updateFunctionCode(loadedTarget(), new Uint8Array([1, 2, 3]));

    expect(send).toHaveBeenCalledWith(expect.any(UpdateFunctionCodeCommand));
    expect(result).toMatchObject({ functionName: "dev-function", version: "7", requestId: "req-1" });
  });

  it("invokes Lambda and decodes response payload and log tail", async () => {
    const send = vi.fn().mockResolvedValue({
      StatusCode: 200,
      ExecutedVersion: "$LATEST",
      LogResult: Buffer.from("hello logs").toString("base64"),
      Payload: new TextEncoder().encode(JSON.stringify({ ok: true })),
      $metadata: { requestId: "req-2" }
    });
    const adapter = new AwsLambdaAdapter(() => ({ send }) as never);
    const result = await adapter.invokeFunction(loadedTarget(), { event: true });

    expect(send).toHaveBeenCalledWith(expect.any(InvokeCommand));
    expect(result.payload).toEqual({ ok: true });
    expect(result.logTail).toBe("hello logs");
  });

  it("creates a client for region/profile configuration", () => {
    const client = createLambdaClient({ ...loadedTarget().target, profile: "dev-profile" });
    expect(client.config.region).toBeDefined();
  });
});

function loadedTarget(): LoadedTarget {
  return {
    configPath: "/tmp/lambda-dev.yml",
    projectRoot: "/tmp",
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
      watch: { include: ["src/**/*.ts"], exclude: [], debounceMs: 300 },
      invoke: { afterDeploy: false, logType: "Tail" }
    }
  };
}
