import {
  InvokeCommand,
  LambdaClient,
  UpdateFunctionCodeCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdated,
  type FunctionConfiguration,
  type LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import { z } from "zod";
import { LambdaDevError, toLambdaDevError } from "./errors.js";
import type { LoadedTarget } from "./config.js";
import {
  applyEnvironmentPatch,
  hasEnvironmentPatch,
  patchToMatch,
  type EnvironmentPatchResult,
  type EnvironmentUpdateResult,
} from "./environment.js";
import { parseJson, type JsonValue } from "./json.js";
import { sha256Base64, type FunctionState } from "./snapshot.js";

export type { EnvironmentUpdateResult } from "./environment.js";

// Lambda's environment response is checked at runtime: an Error means the values couldn't be decrypted.
const lambdaEnvironmentSchema = z
  .object({ Error: z.unknown().optional(), Variables: z.unknown().optional() })
  .optional();

const lambdaEnvironmentVariablesSchema = z.record(z.string(), z.string()).optional();

// Lambda's limit for a zip uploaded directly with UpdateFunctionCode, rather than through S3.
const MAX_DIRECT_UPLOAD_BYTES = 50 * 1024 * 1024;

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
  payload?: JsonValue;
}

export interface LambdaAdapter {
  updateEnvironment(loaded: LoadedTarget): Promise<EnvironmentUpdateResult>;
  /** Replace the whole environment, e.g. with a snapshot's. */
  restoreEnvironment(
    loaded: LoadedTarget,
    variables: Record<string, string>,
  ): Promise<EnvironmentUpdateResult>;
  /** Read the function's current code and environment, for a rollback snapshot. */
  downloadFunction(loaded: LoadedTarget): Promise<FunctionState>;
  waitForUpdate(loaded: LoadedTarget): Promise<void>;
  updateFunctionCode(loaded: LoadedTarget, artifactBytes: Uint8Array): Promise<DeployResult>;
  invokeFunction(
    loaded: LoadedTarget,
    payload: JsonValue | undefined,
    logType?: "None" | "Tail",
  ): Promise<InvokeResult>;
}

export function createLambdaClient(target: LoadedTarget["target"]): LambdaClient {
  const config: LambdaClientConfig = { region: target.region };

  if (target.profile) {
    // The default credential chain uses this profile ahead of environment credentials,
    // including SSO and credential_process profiles.
    config.profile = target.profile;
  }

  return new LambdaClient(config);
}

export class AwsLambdaAdapter implements LambdaAdapter {
  constructor(
    private readonly clientFactory = createLambdaClient,
    private readonly updateWaiter = waitUntilFunctionUpdated,
    private readonly downloadCode = fetchCode,
  ) {}

  async updateEnvironment(loaded: LoadedTarget): Promise<EnvironmentUpdateResult> {
    const patch = loaded.target.environment;

    if (!hasEnvironmentPatch(patch)) return { changed: false, updatedCount: 0, deletedCount: 0 };

    return this.writeEnvironment(
      loaded,
      (existing) => applyEnvironmentPatch(existing, patch),
      "Failed to synchronize Lambda environment",
    );
  }

  async restoreEnvironment(
    loaded: LoadedTarget,
    variables: Record<string, string>,
  ): Promise<EnvironmentUpdateResult> {
    return this.writeEnvironment(
      loaded,
      (existing) => applyEnvironmentPatch(existing, patchToMatch(existing, variables)),
      "Failed to restore Lambda environment",
    );
  }

  async downloadFunction(loaded: LoadedTarget): Promise<FunctionState> {
    try {
      const client = this.clientFactory(loaded.target);

      const result = await client.send(
        new GetFunctionCommand({ FunctionName: loaded.target.functionName }),
        { abortSignal: AbortSignal.timeout(120_000) },
      );

      const configuration = result.Configuration ?? {};

      if (configuration.PackageType === "Image") {
        throw new LambdaDevError("aws_snapshot", "The function is deployed as a container image", {
          hint: "aws-lambda-dev only deploys .zip functions. Nothing was changed.",
        });
      }

      const location = result.Code?.Location;
      const codeSha256 = configuration.CodeSha256;

      if (!location || !codeSha256) {
        throw new LambdaDevError("aws_snapshot", "Lambda didn't return the function's code", {
          hint: "Retry. Nothing was changed.",
        });
      }

      const environment = this.environmentVariables(configuration);
      const code = await this.downloadCode(location);

      if (sha256Base64(code) !== codeSha256) {
        throw new LambdaDevError("aws_snapshot", "The downloaded code doesn't match its checksum", {
          hint: "Retry. Nothing was changed.",
        });
      }

      if (code.byteLength > MAX_DIRECT_UPLOAD_BYTES) {
        throw new LambdaDevError(
          "aws_snapshot",
          `The function's current code is ${Math.ceil(code.byteLength / 1024 / 1024)} MB, too large for rollback to upload directly`,
          {
            hint: "Set snapshot: false on the target to deploy without a rollback snapshot. Nothing was changed.",
          },
        );
      }

      return { code, codeSha256, environment };
    } catch (error) {
      if (error instanceof LambdaDevError) {
        if (error.category === "aws_snapshot") throw error;

        // Environment read failures (e.g. KMS access) are reported as snapshot failures here.
        throw new LambdaDevError("aws_snapshot", error.message, {
          hint: error.hint,
          cause: error,
        });
      }

      throw withCredentialsHint(snapshotAwsError(error), error, loaded.target.profile);
    }
  }

  private async writeEnvironment(
    loaded: LoadedTarget,
    plan: (existing: Record<string, string>) => EnvironmentPatchResult,
    failure: string,
  ): Promise<EnvironmentUpdateResult> {
    try {
      const client = this.clientFactory(loaded.target);
      let configuration = await this.readConfiguration(client, loaded);

      if (configuration.LastUpdateStatus === "InProgress") {
        await this.waitWithClient(client, loaded, "existing update");
        configuration = await this.readConfiguration(client, loaded);
      }

      this.assertReady(configuration);
      const existing = this.environmentVariables(configuration);
      const { variables, result } = plan(existing);

      if (!result.changed) return result;

      if (!configuration.RevisionId) {
        throw new LambdaDevError("aws_configuration", "Lambda configuration revision is missing", {
          hint: "Retry after confirming the function configuration can be read. No configuration was written.",
        });
      }

      await client.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: loaded.target.functionName,
          Environment: { Variables: variables },
          RevisionId: configuration.RevisionId,
        }),
        { abortSignal: AbortSignal.timeout(120_000) },
      );
      await this.waitWithClient(client, loaded, "environment update");
      const updated = await this.readConfiguration(client, loaded);
      this.assertReady(updated, true);
      this.environmentVariables(updated);

      return result;
    } catch (error) {
      if (error instanceof LambdaDevError) throw error;
      throw withCredentialsHint(environmentAwsError(error, failure), error, loaded.target.profile);
    }
  }

  async waitForUpdate(loaded: LoadedTarget): Promise<void> {
    try {
      const client = this.clientFactory(loaded.target);
      await this.waitWithClient(client, loaded, "code update");
      this.assertReady(await this.readConfiguration(client, loaded), true);
    } catch (error) {
      if (error instanceof LambdaDevError) throw error;
      throw withCredentialsHint(
        environmentAwsError(error, "Failed waiting for Lambda code update completion"),
        error,
        loaded.target.profile,
      );
    }
  }

  private async readConfiguration(client: LambdaClient, loaded: LoadedTarget) {
    return client.send(
      new GetFunctionConfigurationCommand({ FunctionName: loaded.target.functionName }),
      {
        abortSignal: AbortSignal.timeout(120_000),
      },
    );
  }

  private environmentVariables(configuration: FunctionConfiguration): Record<string, string> {
    const environment = lambdaEnvironmentSchema.safeParse(configuration.Environment);

    if (!environment.success) {
      throw new LambdaDevError(
        "aws_configuration",
        "Lambda returned an invalid environment response",
      );
    }

    if (environment.data?.Error !== undefined) {
      throw new LambdaDevError("aws_configuration", "Unable to read Lambda environment", {
        hint: "Check environment encryption and IAM/KMS access before retrying. A previous remote change may have completed.",
      });
    }

    const variables = lambdaEnvironmentVariablesSchema.safeParse(environment.data?.Variables);

    if (!variables.success) {
      throw new LambdaDevError("aws_configuration", "Lambda returned an invalid environment map");
    }

    return variables.data ?? {};
  }

  private async waitWithClient(
    client: LambdaClient,
    loaded: LoadedTarget,
    stage: string,
  ): Promise<void> {
    try {
      await this.updateWaiter(
        {
          client,
          maxWaitTime: 120,
          minDelay: 1,
          maxDelay: 5,
          abortSignal: AbortSignal.timeout(120_000),
        },
        { FunctionName: loaded.target.functionName },
      );
    } catch {
      // Waiter errors can embed the entire configuration, including environment values.
      throw new LambdaDevError(
        "aws_configuration",
        `Lambda ${stage} did not complete successfully within the 120-second wait`,
        {
          hint: "Inspect Lambda update status and permissions. A remote change may still complete; retry only when stable. Environment or code may already have changed.",
        },
      );
    }
  }

  private assertReady(configuration: FunctionConfiguration, requireSuccessful = false): void {
    if (
      configuration.State !== "Active" ||
      (requireSuccessful
        ? configuration.LastUpdateStatus !== "Successful"
        : configuration.LastUpdateStatus !== undefined &&
          configuration.LastUpdateStatus !== "Successful")
    ) {
      throw new LambdaDevError(
        "aws_configuration",
        "Lambda is not active with a successful update state",
        {
          hint: "Inspect the function state and last update status before retrying. Earlier remote changes may already have completed.",
        },
      );
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
        throw withCredentialsHint(
          environmentAwsError(
            error,
            "Failed to upload Lambda code; environment synchronization already completed",
            "aws_deploy",
          ),
          error,
          loaded.target.profile,
        );
      }

      throw withCredentialsHint(
        toLambdaDevError("aws_deploy", `Failed to upload ${loaded.target.functionName}`, error),
        error,
        loaded.target.profile,
      );
    }
  }

  async invokeFunction(
    loaded: LoadedTarget,
    payload: JsonValue | undefined,
    logType: "None" | "Tail" = "Tail",
  ): Promise<InvokeResult> {
    const client = this.clientFactory(loaded.target);

    try {
      const result = await client.send(
        new InvokeCommand({
          FunctionName: loaded.target.functionName,
          InvocationType: "RequestResponse",
          LogType: logType,
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
      throw withCredentialsHint(
        toLambdaDevError("aws_invoke", `Failed to invoke ${loaded.target.functionName}`, error),
        error,
        loaded.target.profile,
      );
    }
  }
}

function environmentAwsError(
  cause: unknown,
  stage: string,
  category: "aws_configuration" | "aws_deploy" = "aws_configuration",
): LambdaDevError {
  const code = cause instanceof Error ? cause.name : "";

  const knownCodes = new Set([
    "PreconditionFailedException",
    "ResourceConflictException",
    "AccessDeniedException",
    "ResourceNotFoundException",
    "InvalidParameterValueException",
    "TooManyRequestsException",
    "KMSAccessDeniedException",
    "KMSInvalidStateException",
    "KMSNotFoundException",
    "AbortError",
    "TimeoutError",
  ]);

  return new LambdaDevError(category, `${stage}${knownCodes.has(code) ? ` (${code})` : ""}`, {
    hint:
      code === "PreconditionFailedException"
        ? "Configuration changed concurrently. Rerun the deployment to read a fresh revision; no stale write was retried."
        : "Check Lambda status and IAM/KMS permissions, then retry when stable. Earlier remote changes may already have completed.",
  });
}

function snapshotAwsError(cause: unknown): LambdaDevError {
  const code = cause instanceof Error ? cause.name : "";

  const knownCodes = new Set([
    "AccessDeniedException",
    "ResourceNotFoundException",
    "TooManyRequestsException",
    "AbortError",
    "TimeoutError",
  ]);

  return new LambdaDevError(
    "aws_snapshot",
    `Failed to save the function's current code for rollback${knownCodes.has(code) ? ` (${code})` : ""}`,
    {
      cause,
      hint:
        code === "AccessDeniedException"
          ? "Allow lambda:GetFunction on the function, or set snapshot: false on the target to deploy without a rollback snapshot. Nothing was changed."
          : "Check the function name, region, and credentials, then retry. Nothing was changed.",
    },
  );
}

async function fetchCode(url: string): Promise<Uint8Array> {
  // The URL is a presigned S3 link to the function's code, returned by GetFunction.
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });

  if (!response.ok) {
    throw new LambdaDevError(
      "aws_snapshot",
      `Downloading the function's code failed (HTTP ${response.status})`,
      { hint: "Retry. Nothing was changed." },
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

function withCredentialsHint(
  error: LambdaDevError,
  cause: unknown,
  profile?: string,
): LambdaDevError {
  if (!(cause instanceof Error) || cause.name !== "CredentialsProviderError") return error;

  const hint = profile
    ? `Check that AWS profile "${profile}" exists in your AWS config and has valid credentials (for SSO, run: aws sso login --profile ${profile}).`
    : "No AWS credentials found. Set profile in lambda-dev.yml, or configure credentials with environment variables, ~/.aws, or SSO.";

  return new LambdaDevError(error.category, error.message, { hint, cause });
}

function encodePayload(payload: JsonValue | undefined): Uint8Array | undefined {
  if (payload === undefined) {
    return undefined;
  }

  return new TextEncoder().encode(JSON.stringify(payload));
}

function decodePayload(payload: Uint8Array | undefined): JsonValue | undefined {
  if (!payload || payload.byteLength === 0) {
    return undefined;
  }

  const text = new TextDecoder().decode(payload);

  try {
    return parseJson(text);
  } catch {
    return text;
  }
}

export function safeAwsError(
  cause: unknown,
  fallbackCategory: "aws_deploy" | "aws_invoke",
): LambdaDevError {
  if (cause instanceof LambdaDevError) {
    return cause;
  }

  return toLambdaDevError(fallbackCategory, "AWS operation failed", cause);
}
