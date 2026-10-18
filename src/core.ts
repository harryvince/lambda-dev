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

export interface DeploySummary {
  build: BuildResult;
  deploy: DeployResult;
  invoke?: InvokeResult;
  environment?: EnvironmentUpdateResult;
}

export async function deployTarget(options: DeployOptions): Promise<DeploySummary> {
  const loaded = await loadTarget(options.configPath, options.targetName);
  const deps = resolveDeps(options.deps);
  logStep(options.logger, loaded.targetName, "build", `Building ${loaded.target.build.entry}`);
  const build = await deps.buildArtifact(loaded);
  logStep(
    options.logger,
    loaded.targetName,
    "build",
    `Created ${build.artifactPath} (${build.sizeBytes} bytes, ${build.durationMs} ms)`,
  );

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

  if (!shouldInvoke) {
    return { build, deploy, ...(environment ? { environment } : {}) };
  }

  const payload = await resolvePayload(loaded, options.payloadFile, options.payloadJson);
  logStep(options.logger, loaded.targetName, "invoke", `Payload ${previewPayload(payload, 300)}`);
  const invoke = await deps.lambda.invokeFunction(loaded, payload, loaded.target.invoke.logType);
  logStep(options.logger, loaded.targetName, "invoke", formatInvokeSummary(invoke));

  return { build, deploy, invoke, ...(environment ? { environment } : {}) };
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
): Promise<unknown> {
  if (payloadJson !== undefined) {
    return JSON.parse(payloadJson);
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

  return JSON.parse(raw);
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

function resolveDeps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    buildArtifact: overrides.buildArtifact ?? buildArtifact,
    lambda: overrides.lambda ?? new AwsLambdaAdapter(),
  };
}
