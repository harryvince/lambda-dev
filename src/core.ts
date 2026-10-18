import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildArtifact, type BuildResult } from "./build.js";
import {
  AwsLambdaAdapter,
  type InvokeResult,
  type LambdaAdapter,
  type DeployResult,
} from "./aws.js";
import { loadTarget, type CheckConfig, type Expectation, type LoadedTarget } from "./config.js";
import { findMismatches } from "./expect.js";
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
  /** false skips invoke.expect for this deploy's invoke. */
  expect?: boolean;
  /** Run every configured check after the upload. */
  check?: boolean;
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

export interface CheckOptions {
  configPath?: string;
  targetName?: string;
  /** Checks to run, by name. All of them when empty or missing. */
  names?: string[];
  logger: Logger;
  deps?: Partial<RuntimeDeps>;
}

export interface CheckResult {
  name: string;
  invoke: InvokeResult;
  /** Why the response didn't match; empty when the check passed. */
  mismatches: string[];
}

export interface InvokeOptions {
  configPath?: string;
  targetName?: string;
  payloadFile?: string;
  payloadJson?: string;
  /** false skips invoke.expect for this invoke. */
  expect?: boolean;
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
  checks?: CheckResult[];
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

  // Fail on a check-less target before building, like any other config problem.
  const checks = options.check ? selectChecks(loaded, []) : [];
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

  if (shouldInvoke) {
    const payload = await resolvePayload(loaded, options.payloadFile, options.payloadJson);
    logStep(options.logger, loaded.targetName, "invoke", `Payload ${previewPayload(payload, 300)}`);
    const invoke = await deps.lambda.invokeFunction(loaded, payload, loaded.target.invoke.logType);
    logStep(options.logger, loaded.targetName, "invoke", formatInvokeSummary(invoke));
    summary.invoke = invoke;

    if (options.expect !== false) {
      assertInvokeExpectation(loaded, invoke, options.logger);
    }
  }

  if (checks.length > 0) {
    summary.checks = await runChecks(loaded, checks, deps, options.logger);
  }

  return summary;
}

/** Invoke a target with each named check's event and compare the responses with what's expected. */
export async function checkTarget(options: CheckOptions): Promise<CheckResult[]> {
  const loaded = await loadTarget(options.configPath, options.targetName);
  const deps = resolveDeps(options.deps);
  const checks = selectChecks(loaded, options.names ?? []);

  return runChecks(loaded, checks, deps, options.logger);
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

  if (options.expect !== false) {
    assertInvokeExpectation(loaded, result, options.logger);
  }

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

  return readConfiguredPayload(
    loaded,
    loaded.target.invoke.payloadJson,
    payloadFile ?? loaded.target.invoke.payloadFile,
  );
}

async function readConfiguredPayload(
  loaded: LoadedTarget,
  payloadJson: JsonValue | undefined,
  payloadFile: string | undefined,
): Promise<JsonValue | undefined> {
  if (payloadJson !== undefined) {
    return payloadJson;
  }

  if (!payloadFile) {
    return undefined;
  }

  const raw = await readFile(path.resolve(loaded.projectRoot, payloadFile), "utf8");

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

interface NamedCheck {
  name: string;
  check: CheckConfig;
}

/** Look up checks by name, all of them when no names are given. Unknown names fail validation. */
function selectChecks(loaded: LoadedTarget, names: string[]): NamedCheck[] {
  const configured = loaded.target.checks;
  const available = Object.keys(configured);

  if (available.length === 0) {
    throw new LambdaDevError("validation", `Target ${loaded.targetName} has no checks`, {
      hint: "Add a checks section to the target in lambda-dev.yml.",
    });
  }

  const selected = names.length > 0 ? names : available;

  return selected.map((name) => {
    const check = configured[name];

    if (!check) {
      throw new LambdaDevError(
        "validation",
        `Unknown check "${name}". Available checks: ${available.join(", ")}`,
      );
    }

    return { name, check };
  });
}

/** Run every check, then fail if any of them didn't get the expected response. */
async function runChecks(
  loaded: LoadedTarget,
  checks: NamedCheck[],
  deps: RuntimeDeps,
  logger: Logger,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const { name, check } of checks) {
    const payload = await readConfiguredPayload(loaded, check.payloadJson, check.payloadFile);
    const invoke = await deps.lambda.invokeFunction(loaded, payload, loaded.target.invoke.logType);
    const mismatches = findMismatches(check.expect, invoke);

    if (mismatches.length === 0) {
      logStep(
        logger,
        loaded.targetName,
        "check",
        `${name} passed (${formatInvokeSummary(invoke)})`,
      );
    } else {
      logStep(logger, loaded.targetName, "check", `${name} failed: ${mismatches.join("; ")}`);
    }

    results.push({ name, invoke, mismatches });
  }

  const failed = results.filter((result) => result.mismatches.length > 0);

  if (failed.length > 0) {
    throw new LambdaDevError(
      "aws_invoke",
      `${failed.length} of ${results.length} checks failed for ${loaded.target.functionName}: ${failed.map((result) => result.name).join(", ")}`,
      { hint: "Each check's mismatches are logged above. Nothing was rolled back." },
    );
  }

  return results;
}

function assertInvokeExpectation(loaded: LoadedTarget, invoke: InvokeResult, logger: Logger): void {
  const expectation: Expectation | undefined = loaded.target.invoke.expect;

  if (!expectation) {
    return;
  }

  const mismatches = findMismatches(expectation, invoke);

  if (mismatches.length === 0) {
    logStep(logger, loaded.targetName, "invoke", "Response matches invoke.expect");

    return;
  }

  throw new LambdaDevError(
    "aws_invoke",
    `${loaded.target.functionName} didn't respond as invoke.expect describes: ${mismatches.join("; ")}`,
    { hint: "Pass --no-expect to invoke without checking the response." },
  );
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
