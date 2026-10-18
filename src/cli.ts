#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { z } from "zod";
import {
  buildTarget,
  checkTarget,
  deployTarget,
  invokeTarget,
  rollbackTarget,
  validateTarget,
} from "./core.js";
import { formatError, consoleLogger } from "./output.js";
import { writeStarterConfig } from "./scaffold.js";
import { watchTarget } from "./watch.js";

// Declared before the entrypoint check below runs main(), which reads the package version.
const packageVersionSchema = z.object({ version: z.string() });

export function createProgram(): Command {
  const program = new Command();

  program
    .name("aws-lambda-dev")
    .description("Hot-reload, deploy, and invoke existing AWS Lambda functions.")
    .version(readPackageVersionSyncFallback());

  program
    .command("init")
    .description("Create a starter lambda-dev.yml config.")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .action(async (options) => {
      const outputPath = await writeStarterConfig(options.config);
      consoleLogger.info(`Created ${outputPath}`);
    });

  program
    .command("validate")
    .description("Validate config and target selection.")
    .argument("[target]", "Target name")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .action(async (target, options) => {
      const loaded = await validateTarget(options.config, target);
      consoleLogger.info(`[${loaded.targetName}] validation: ok`);
    });

  program
    .command("build")
    .description("Build a target's zip without deploying it.")
    .argument("[target]", "Target name")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .option("--no-cache", "Rebuild even if a cached build matches")
    .action(async (target, options) => {
      await buildTarget({
        configPath: options.config,
        targetName: target,
        cache: options.cache,
        logger: consoleLogger,
      });
    });

  program
    .command("deploy")
    .description("Build and upload a target once.")
    .argument("[target]", "Target name")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .option("--invoke", "Invoke after upload")
    .option("--payload-file <path>", "Invoke payload JSON file")
    .option("--payload-json <json>", "Invoke payload JSON string")
    .option("--no-cache", "Rebuild even if a cached build matches")
    .option("--no-expect", "Don't compare the invoke response with invoke.expect")
    .option("--check", "Run the target's checks after uploading")
    .option("-y, --yes", "Deploy a protected target without asking")
    .option("--no-rollback", "Keep the new code deployed when checks or invoke.expect fail")
    .action(async (target, options) => {
      await deployTarget({
        yes: options.yes,
        rollback: options.rollback,
        configPath: options.config,
        targetName: target,
        invoke: options.invoke,
        cache: options.cache,
        expect: options.expect,
        check: options.check,
        payloadFile: options.payloadFile,
        payloadJson: options.payloadJson,
        logger: consoleLogger,
      });
    });

  program
    .command("invoke")
    .description("Invoke a configured Lambda target without rebuilding.")
    .argument("[target]", "Target name")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .option("--payload-file <path>", "Invoke payload JSON file")
    .option("--payload-json <json>", "Invoke payload JSON string")
    .option("--no-expect", "Don't compare the response with invoke.expect")
    .action(async (target, options) => {
      await invokeTarget({
        configPath: options.config,
        targetName: target,
        payloadFile: options.payloadFile,
        payloadJson: options.payloadJson,
        expect: options.expect,
        logger: consoleLogger,
      });
    });

  program
    .command("check")
    .description("Invoke a target with each check's event and verify the responses.")
    .argument("[target]", "Target name")
    .argument("[checks...]", "Checks to run (default: all)")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .action(async (target, checks, options) => {
      await checkTarget({
        configPath: options.config,
        targetName: target,
        names: checks,
        logger: consoleLogger,
      });
    });

  program
    .command("rollback")
    .description("Restore a target's function to how it was before its first deploy.")
    .argument("[target]", "Target name")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .option("-y, --yes", "Roll back a protected target without asking")
    .action(async (target, options) => {
      await rollbackTarget({
        yes: options.yes,
        configPath: options.config,
        targetName: target,
        logger: consoleLogger,
      });
    });

  program
    .command("watch")
    .description("Watch files, rebuild, upload, and optionally invoke on save.")
    .argument("[target]", "Target name")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .action(async (target, options) => {
      await watchTarget({
        configPath: options.config,
        targetName: target,
        logger: consoleLogger,
      });
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = createProgram();

  try {
    await program.parseAsync(argv);
  } catch (error) {
    consoleLogger.error(formatError(error));
    process.exitCode = 1;
  }
}

if (isCliEntrypoint(process.argv[1])) {
  await main();
}

function isCliEntrypoint(argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return import.meta.url === pathToFileURL(argvPath).href;
  }
}

function readPackageVersionSyncFallback(): string {
  // Commander needs the version during program construction. Keep this fallback
  // tiny so release versioning remains owned by package.json and mise.
  const packageUrl = new URL("../package.json", import.meta.url);

  try {
    const packageJson = packageVersionSchema.safeParse(
      JSON.parse(readFileSync(packageUrl, "utf8")),
    );

    return packageJson.success ? packageJson.data.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
