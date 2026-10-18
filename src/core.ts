import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildArtifact, type BuildResult } from "./build.js";
import {
  AwsLambdaAdapter,
  type InvokeResult,
  type LambdaAdapter,
  type DeployResult,
} from "./aws.js";
import { loadTarget, type LoadedTarget } from "./config.js";
import { logStep, previewPayload, type Logger } from "./output.js";
import { hasEnvironmentPatch, type EnvironmentUpdateResult } from "./environment.js";
import { parseJson, type JsonValue } from "./json.js";
import {
  assertOutDirKeepsSnapshots,
  deleteSnapshot,
  hasSnapshot,
  readSnapshot,
  snapshotDirectory,
  writeSnapshot,
} from "./snapshot.js";
import { LambdaDevError } from "./errors.js";

export interface RuntimeDeps {
  buildArtifact: (loaded: LoadedTarget) => Promise<BuildResult>;
  lambda: LambdaAdapter;
}

export interface DeployOptions {
  configPath?: string;
  targetName?: string;
  invoke?: boolean;
  payloadFile?: string;
  payloadJson?: string;
  /** false skips the build cache for this deploy, whatever build.cache says. */
  cache?: boolean;
  logger: Logger;
  deps?: Partial<RuntimeDeps>;
}

export interface BuildOptions {
  configPath?: string;
  targetName?: string;
  /** false skips the build cache for this build, whatever build.cache says. */
  cache?: boolean;
  logger: Logger;
  deps?: Partial<RuntimeDeps>;
}

export interface InvokeOptions {
  configPath?: string;
  targetName?: string;
  payloadFile?: string;
  payloadJson?: string;
  logger: Logger;
  deps?: Partial<RuntimeDeps>;
}

export interface RollbackOptions {
  configPath?: string;
  targetName?: string;
  logger: Logger;
  deps?: Partial<RuntimeDeps>;
}

export interface RollbackSummary {
  /** When the restored snapshot was taken, as an ISO timestamp. */
  snapshotCreatedAt: string;
  environment: EnvironmentUpdateResult;
  deploy: DeployResult;
}

export interface DeploySummary {
  build: BuildResult;
  deploy: DeployResult;
  invoke?: InvokeResult;
  environment?: EnvironmentUpdateResult;
}

/** Build a target's zip without touching AWS. */
export async function buildTarget(options: BuildOptions): Promise<BuildResult> {
  const loaded = await loadTarget(options.configPath, options.targetName);
  const deps = resolveDeps(options.deps);

  if (options.cache === false) {
    loaded.target.build.cache = false;
  }

  return runBuild(loaded, deps, options.logger);
}

export async function deployTarget(options: DeployOptions): Promise<DeploySummary> {
  const loaded = await loadTarget(options.configPath, options.targetName);
  const deps = resolveDeps(options.deps);

  if (options.cache === false) {
    loaded.target.build.cache = false;
  }

  if (loaded.target.snapshot) {
    assertOutDirKeepsSnapshots(loaded);
  }

  const build = await runBuild(loaded, deps, options.logger);

  if (loaded.target.snapshot) {
    await ensureSnapshot(loaded, deps, options.logger);
  }

  let environment: EnvironmentUpdateResult | undefined;

  if (hasEnvironmentPatch(loaded.target.environment)) {
    logStep(
      options.logger,
      loaded.targetName,
      "configuration",
      "Synchronizing environment variables",
    );
    environment = await deps.lambda.updateEnvironment(loaded);
    logStep(
      options.logger,
      loaded.targetName,
      "configuration",
      environment.changed
        ? `Updated ${environment.updatedCount} and deleted ${environment.deletedCount} variables`
        : "Environment already matches; no configuration write needed",
    );
  }

  logStep(
    options.logger,
    loaded.targetName,
    "deploy",
    `Uploading to ${loaded.target.functionName}`,
  );
  const deploy = await deps.lambda.updateFunctionCode(loaded, build.artifactBytes);

  if (environment) {
    logStep(options.logger, loaded.targetName, "deploy", "Waiting for code update completion");
    await deps.lambda.waitForUpdate(loaded);
  }

  logStep(
    options.logger,
    loaded.targetName,
    "deploy",
    `Uploaded ${deploy.functionName}${deploy.version ? ` version ${deploy.version}` : ""}`,
  );

  const shouldInvoke = options.invoke ?? loaded.target.invoke.afterDeploy;

  const summary: DeploySummary = { build, deploy };

  if (environment) {
    summary.environment = environment;
  }

  if (!shouldInvoke) {
    return summary;
  }

  const payload = await resolvePayload(loaded, options.payloadFile, options.payloadJson);
  logStep(options.logger, loaded.targetName, "invoke", `Payload ${previewPayload(payload, 300)}`);
  const invoke = await deps.lambda.invokeFunction(loaded, payload, loaded.target.invoke.logType);
  logStep(options.logger, loaded.targetName, "invoke", formatInvokeSummary(invoke));

  summary.invoke = invoke;

  return summary;
}

/** Put the function back to its snapshot from before the first deploy, then delete the snapshot. */
export async function rollbackTarget(options: RollbackOptions): Promise<RollbackSummary> {
  const loaded = await loadTarget(options.configPath, options.targetName);
  const deps = resolveDeps(options.deps);
  const snapshot = await readSnapshot(loaded);

  if (!snapshot) {
    throw new LambdaDevError(
      "validation",
      `No rollback snapshot for ${loaded.target.functionName} in ${loaded.target.region}`,
      {
        hint: `A snapshot is saved before the first deploy to a function and deleted after a rollback. Expected one in ${snapshotDirectory(loaded)}.`,
      },
    );
  }

  logStep(
    options.logger,
    loaded.targetName,
    "rollback",
    `Restoring ${loaded.target.functionName} to its snapshot from ${snapshot.createdAt}`,
  );

  const environment = await deps.lambda.restoreEnvironment(loaded, snapshot.environment);
  logStep(
    options.logger,
    loaded.targetName,
    "rollback",
    environment.changed
      ? `Restored the environment (${environment.updatedCount} set, ${environment.deletedCount} deleted)`
      : "Environment already matches the snapshot",
  );

  logStep(options.logger, loaded.targetName, "rollback", "Uploading the original code");
  const deploy = await deps.lambda.updateFunctionCode(loaded, snapshot.code);
  await deps.lambda.waitForUpdate(loaded);

  await deleteSnapshot(loaded);
  logStep(
    options.logger,
    loaded.targetName,
    "rollback",
    "Restored. The snapshot was deleted; the next deploy will take a new one.",
  );

  return { snapshotCreatedAt: snapshot.createdAt, environment, deploy };
}

export async function invokeTarget(options: InvokeOptions): Promise<InvokeResult> {
  const loaded = await loadTarget(options.configPath, options.targetName);
  const deps = resolveDeps(options.deps);
  const payload = await resolvePayload(loaded, options.payloadFile, options.payloadJson);
  logStep(options.logger, loaded.targetName, "invoke", `Invoking ${loaded.target.functionName}`);
  const result = await deps.lambda.invokeFunction(loaded, payload, loaded.target.invoke.logType);
  logStep(options.logger, loaded.targetName, "invoke", formatInvokeSummary(result));

  return result;
}

export async function validateTarget(
  configPath?: string,
  targetName?: string,
): Promise<LoadedTarget> {
  return loadTarget(configPath, targetName);
}

export async function resolvePayload(
  loaded: LoadedTarget,
  payloadFile?: string,
  payloadJson?: string,
): Promise<JsonValue | undefined> {
  if (payloadJson !== undefined) {
    return parseJson(payloadJson);
  }

  const configuredPayload = loaded.target.invoke.payloadJson;

  if (configuredPayload !== undefined) {
    return configuredPayload;
  }

  const file = payloadFile ?? loaded.target.invoke.payloadFile;

  if (!file) {
    return undefined;
  }

  const raw = await readFile(path.resolve(loaded.projectRoot, file), "utf8");

  return parseJson(raw);
}

export function formatInvokeSummary(result: InvokeResult): string {
  const parts = [`status ${result.statusCode ?? "unknown"}`];

  if (result.functionError) {
    parts.push(`functionError ${result.functionError}`);
  }

  if (result.executedVersion) {
    parts.push(`version ${result.executedVersion}`);
  }

  if (result.logTail) {
    parts.push("logs available");
  }

  if (result.payload !== undefined) {
    parts.push(`payload ${previewPayload(result.payload, 500)}`);
  }

  return parts.join(", ");
}

async function runBuild(
  loaded: LoadedTarget,
  deps: RuntimeDeps,
  logger: Logger,
): Promise<BuildResult> {
  logStep(logger, loaded.targetName, "build", `Building ${loaded.target.build.entry}`);
  const build = await deps.buildArtifact(loaded);
  logStep(
    logger,
    loaded.targetName,
    "build",
    `${build.cached ? "Reused cached build for" : "Created"} ${build.artifactPath} (${build.sizeBytes} bytes, ${build.durationMs} ms)`,
  );

  return build;
}

async function ensureSnapshot(
  loaded: LoadedTarget,
  deps: RuntimeDeps,
  logger: Logger,
): Promise<void> {
  if (await hasSnapshot(loaded)) {
    return;
  }

  logStep(
    logger,
    loaded.targetName,
    "snapshot",
    `Saving the current code and environment of ${loaded.target.functionName} for rollback`,
  );
  const state = await deps.lambda.downloadFunction(loaded);
  const directory = await writeSnapshot(loaded, state);
  logStep(
    logger,
    loaded.targetName,
    "snapshot",
    `Saved to ${path.relative(loaded.projectRoot, directory)}`,
  );
}

function resolveDeps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    buildArtifact: overrides.buildArtifact ?? buildArtifact,
    lambda: overrides.lambda ?? new AwsLambdaAdapter(),
  };
}
