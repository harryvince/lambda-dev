import {
  InvokeCommand,
  LambdaClient,
  LogType,
  UpdateFunctionCodeCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdated,
  type GetFunctionConfigurationCommandOutput,
  type LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import { fromIni } from "@aws-sdk/credential-providers";
import { LambdaDevError, toLambdaDevError } from "./errors.js";
import type { LoadedTarget } from "./config.js";
import { applyEnvironmentPatch, hasEnvironmentPatch, type EnvironmentUpdateResult } from "./environment.js";
export type { EnvironmentUpdateResult } from "./environment.js";

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
  updateEnvironment(loaded: LoadedTarget): Promise<EnvironmentUpdateResult>;
  waitForUpdate(loaded: LoadedTarget): Promise<void>;
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
  constructor(
    private readonly clientFactory = createLambdaClient,
    private readonly updateWaiter = waitUntilFunctionUpdated,
  ) {}

  async updateEnvironment(loaded: LoadedTarget): Promise<EnvironmentUpdateResult> {
    const patch = loaded.target.environment;
    if (!hasEnvironmentPatch(patch)) return { changed: false, updatedCount: 0, deletedCount: 0 };
    try {
      const client = this.clientFactory(loaded.target);
      let configuration = await this.readConfiguration(client, loaded);
      if (configuration.LastUpdateStatus === "InProgress") {
        await this.waitWithClient(client, loaded, "existing update");
        configuration = await this.readConfiguration(client, loaded);
      }
      this.assertReady(configuration);
      const existing = this.environmentVariables(configuration);
      const { variables, result } = applyEnvironmentPatch(existing, patch);
      if (!result.changed) return result;
      if (typeof configuration.RevisionId !== "string" || !configuration.RevisionId) {
        throw new LambdaDevError("aws_configuration", "Lambda configuration revision is missing", {
          hint: "Retry after confirming the function configuration can be read. No configuration was written.",
        });
      }
      await client.send(new UpdateFunctionConfigurationCommand({
        FunctionName: loaded.target.functionName,
        Environment: { Variables: variables },
        RevisionId: configuration.RevisionId,
      }), { abortSignal: AbortSignal.timeout(120_000) });
      await this.waitWithClient(client, loaded, "environment update");
      const updated = await this.readConfiguration(client, loaded);
      this.assertReady(updated, true);
      this.environmentVariables(updated);
      return result;
    } catch (error) {
      if (error instanceof LambdaDevError) throw error;
      throw environmentAwsError(error, "Failed to synchronize Lambda environment");
    }
  }

  async waitForUpdate(loaded: LoadedTarget): Promise<void> {
    try {
      const client = this.clientFactory(loaded.target);
      await this.waitWithClient(client, loaded, "code update");
      this.assertReady(await this.readConfiguration(client, loaded), true);
    } catch (error) {
      if (error instanceof LambdaDevError) throw error;
      throw environmentAwsError(error, "Failed waiting for Lambda code update completion");
    }
  }

  private async readConfiguration(client: LambdaClient, loaded: LoadedTarget) {
    return client.send(new GetFunctionConfigurationCommand({ FunctionName: loaded.target.functionName }), {
      abortSignal: AbortSignal.timeout(120_000),
    });
  }

  private environmentVariables(configuration: GetFunctionConfigurationCommandOutput): Record<string, string> {
    const environment = configuration.Environment;
    if (environment !== undefined && (environment === null || typeof environment !== "object" || Array.isArray(environment))) {
      throw new LambdaDevError("aws_configuration", "Lambda returned an invalid environment response");
    }
    if (environment?.Error !== undefined) {
      throw new LambdaDevError("aws_configuration", "Unable to read Lambda environment", {
        hint: "Check environment encryption and IAM/KMS access before retrying. A previous remote change may have completed.",
      });
    }
    const variables = environment?.Variables;
    if (variables === undefined) return {};
    if (typeof variables !== "object" || variables === null || Array.isArray(variables) ||
        Object.values(variables).some((value) => typeof value !== "string")) {
      throw new LambdaDevError("aws_configuration", "Lambda returned an invalid environment map");
    }
    return variables;
  }

  private async waitWithClient(client: LambdaClient, loaded: LoadedTarget, stage: string): Promise<void> {
    try {
      await this.updateWaiter({
        client, maxWaitTime: 120, minDelay: 1, maxDelay: 5, abortSignal: AbortSignal.timeout(120_000),
      }, { FunctionName: loaded.target.functionName });
    } catch {
      // Waiter errors can embed the entire configuration, including environment values.
      throw new LambdaDevError("aws_configuration", `Lambda ${stage} did not complete successfully within the 120-second wait`, {
        hint: "Inspect Lambda update status and permissions. A remote change may still complete; retry only when stable. Environment or code may already have changed.",
      });
    }
  }

  private assertReady(configuration: GetFunctionConfigurationCommandOutput, requireSuccessful = false): void {
    if (configuration.State !== "Active" ||
        (requireSuccessful ? configuration.LastUpdateStatus !== "Successful" :
          configuration.LastUpdateStatus !== undefined && configuration.LastUpdateStatus !== "Successful")) {
      throw new LambdaDevError("aws_configuration", "Lambda is not active with a successful update state", {
        hint: "Inspect the function state and last update status before retrying. Earlier remote changes may already have completed.",
      });
    }
  }

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
      if (hasEnvironmentPatch(loaded.target.environment)) {
        throw environmentAwsError(error, "Failed to upload Lambda code; environment synchronization already completed", "aws_deploy");
      }
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

function environmentAwsError(
  error: unknown,
  stage: string,
  category: "aws_configuration" | "aws_deploy" = "aws_configuration",
): LambdaDevError {
  const code = error instanceof Error ? error.name : "";
  const knownCodes = new Set([
    "PreconditionFailedException", "ResourceConflictException", "AccessDeniedException",
    "ResourceNotFoundException", "InvalidParameterValueException", "TooManyRequestsException",
    "KMSAccessDeniedException", "KMSInvalidStateException", "KMSNotFoundException", "AbortError", "TimeoutError",
  ]);
  return new LambdaDevError(category, `${stage}${knownCodes.has(code) ? ` (${code})` : ""}`, {
    hint: code === "PreconditionFailedException"
      ? "Configuration changed concurrently. Rerun the deployment to read a fresh revision; no stale write was retried."
      : "Check Lambda status and IAM/KMS permissions, then retry when stable. Earlier remote changes may already have completed.",
  });
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
