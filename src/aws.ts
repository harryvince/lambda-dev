import {
  InvokeCommand,
  LambdaClient,
  LogType,
  UpdateFunctionCodeCommand,
  type LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import { fromIni } from "@aws-sdk/credential-providers";
import { LambdaDevError, toLambdaDevError } from "./errors.js";
import type { LoadedTarget } from "./config.js";

export interface DeployResult {
  functionName: string;
  version?: string;
  requestId?: string;
}

export interface InvokeResult {
  statusCode?: number;
  functionError?: string;
  executedVersion?: string;
  requestId?: string;
  logTail?: string;
  payload?: unknown;
}

export interface LambdaAdapter {
  updateFunctionCode(loaded: LoadedTarget, artifactBytes: Uint8Array): Promise<DeployResult>;
  invokeFunction(
    loaded: LoadedTarget,
    payload: unknown,
    logType?: "None" | "Tail",
  ): Promise<InvokeResult>;
}

export function createLambdaClient(target: LoadedTarget["target"]): LambdaClient {
  const config: LambdaClientConfig = { region: target.region };
  if (target.profile) {
    config.credentials = fromIni({ profile: target.profile });
  }
  return new LambdaClient(config);
}

export class AwsLambdaAdapter implements LambdaAdapter {
  constructor(private readonly clientFactory = createLambdaClient) {}

  async updateFunctionCode(loaded: LoadedTarget, artifactBytes: Uint8Array): Promise<DeployResult> {
    const client = this.clientFactory(loaded.target);

    try {
      const result = await client.send(
        new UpdateFunctionCodeCommand({
          FunctionName: loaded.target.functionName,
          ZipFile: artifactBytes,
        }),
      );

      return {
        functionName: loaded.target.functionName,
        version: result.Version,
        requestId: result.$metadata.requestId,
      };
    } catch (error) {
      throw toLambdaDevError("aws_deploy", `Failed to upload ${loaded.target.functionName}`, error);
    }
  }

  async invokeFunction(
    loaded: LoadedTarget,
    payload: unknown,
    logType: "None" | "Tail" = "Tail",
  ): Promise<InvokeResult> {
    const client = this.clientFactory(loaded.target);

    try {
      const result = await client.send(
        new InvokeCommand({
          FunctionName: loaded.target.functionName,
          InvocationType: "RequestResponse",
          LogType: logType as LogType,
          Payload: encodePayload(payload),
        }),
      );

      return {
        statusCode: result.StatusCode,
        functionError: result.FunctionError,
        executedVersion: result.ExecutedVersion,
        requestId: result.$metadata.requestId,
        logTail: result.LogResult
          ? Buffer.from(result.LogResult, "base64").toString("utf8")
          : undefined,
        payload: decodePayload(result.Payload),
      };
    } catch (error) {
      throw toLambdaDevError("aws_invoke", `Failed to invoke ${loaded.target.functionName}`, error);
    }
  }
}

function encodePayload(payload: unknown): Uint8Array | undefined {
  if (payload === undefined) {
    return undefined;
  }

  return new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload));
}

function decodePayload(payload: Uint8Array | undefined): unknown {
  if (!payload || payload.byteLength === 0) {
    return undefined;
  }

  const text = new TextDecoder().decode(payload);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function safeAwsError(
  error: unknown,
  fallbackCategory: "aws_deploy" | "aws_invoke",
): LambdaDevError {
  if (error instanceof LambdaDevError) {
    return error;
  }
  return toLambdaDevError(fallbackCategory, "AWS operation failed", error);
}
