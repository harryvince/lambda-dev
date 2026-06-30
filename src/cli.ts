#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { deployTarget, invokeTarget, validateTarget } from "./core.js";
import { formatError, consoleLogger } from "./output.js";
import { writeStarterConfig } from "./scaffold.js";
import { watchTarget } from "./watch.js";

export function createProgram(): Command {
  const program = new Command();

  program.name("aws-lambda-dev").description("Hot-reload, deploy, and invoke existing AWS Lambda functions.").version("1.0.2");

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
    .command("deploy")
    .description("Build and upload a target once.")
    .argument("[target]", "Target name")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .option("--invoke", "Invoke after upload")
    .option("--payload-file <path>", "Invoke payload JSON file")
    .option("--payload-json <json>", "Invoke payload JSON string")
    .action(async (target, options) => {
      await deployTarget({
        configPath: options.config,
        targetName: target,
        invoke: options.invoke,
        payloadFile: options.payloadFile,
        payloadJson: options.payloadJson,
        logger: consoleLogger
      });
    });

  program
    .command("invoke")
    .description("Invoke a configured Lambda target without rebuilding.")
    .argument("[target]", "Target name")
    .option("-c, --config <path>", "Config file path", "lambda-dev.yml")
    .option("--payload-file <path>", "Invoke payload JSON file")
    .option("--payload-json <json>", "Invoke payload JSON string")
    .action(async (target, options) => {
      await invokeTarget({
        configPath: options.config,
        targetName: target,
        payloadFile: options.payloadFile,
        payloadJson: options.payloadJson,
        logger: consoleLogger
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
        logger: consoleLogger
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
