import { LambdaDevError } from "./errors.js";

// Lambda runtime-owned names. Other AWS_ names are not rejected solely by prefix.
export const RESERVED_ENVIRONMENT_KEYS = new Set([
  "_HANDLER", "_X_AMZN_TRACE_ID", "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "AWS_LAMBDA_FUNCTION_VERSION",
  "AWS_LAMBDA_INITIALIZATION_TYPE", "AWS_LAMBDA_LOG_GROUP_NAME", "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AWS_LAMBDA_RUNTIME_API", "LAMBDA_TASK_ROOT", "LAMBDA_RUNTIME_DIR", "AWS_LAMBDA_MAX_CONCURRENCY",
  "AWS_LAMBDA_METADATA_API", "AWS_LAMBDA_METADATA_TOKEN",
]);

export interface EnvironmentUpdateResult {
  changed: boolean;
  updatedCount: number;
  deletedCount: number;
}

export function hasEnvironmentPatch(
  environment: Record<string, string | null> | undefined,
): environment is Record<string, string | null> {
  return environment !== undefined && Object.keys(environment).length > 0;
}

export function applyEnvironmentPatch(
  existing: Record<string, string>,
  patch: Record<string, string | null>,
): { variables: Record<string, string>; result: EnvironmentUpdateResult } {
  const variables = { ...existing };
  let updatedCount = 0;
  let deletedCount = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (Object.hasOwn(variables, key)) {
        delete variables[key];
        deletedCount++;
      }
    } else if (!Object.hasOwn(variables, key) || variables[key] !== value) {
      Object.defineProperty(variables, key, { value, enumerable: true, configurable: true, writable: true });
      updatedCount++;
    }
  }
  const bytes = Object.entries(variables).reduce(
    (total, [key, value]) => total + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"), 0,
  );
  if (bytes > 4096) {
    throw new LambdaDevError("aws_configuration", "Effective Lambda environment exceeds the 4096-byte limit", {
      hint: "Reduce variable names or values, including existing variables retained by this patch.",
    });
  }
  return { variables, result: { changed: updatedCount + deletedCount > 0, updatedCount, deletedCount } };
}
