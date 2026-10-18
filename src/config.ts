import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import { LambdaDevError } from "./errors.js";
import { RESERVED_ENVIRONMENT_KEYS } from "./environment.js";
import { jsonValueSchema } from "./json.js";

const environmentKey = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]+$/,
    "Use a letter first and at least two letters, digits, or underscores",
  )
  .refine((key) => !RESERVED_ENVIRONMENT_KEYS.has(key), "Variable name is reserved by Lambda")
  // Refinements don't reach the generated JSON Schema, so spell the reserved names out for editors.
  .meta({ not: { enum: [...RESERVED_ENVIRONMENT_KEYS] } });

const buildSchema = z
  .object({
    entry: z.string().min(1).meta({
      description: "Handler source file, relative to the config file. Bundled to index.js.",
    }),
    bundle: z.boolean().default(true).meta({ description: "Bundle dependencies into index.js." }),
    platform: z
      .enum(["node", "browser", "neutral"])
      .default("node")
      .meta({ description: "esbuild platform." }),
    target: z
      .string()
      .default("node20")
      .meta({ description: "esbuild target, e.g. node22. Match the function's runtime." }),
    format: z
      .enum(["cjs", "esm", "iife"])
      .default("cjs")
      .meta({ description: "Output module format." }),
    sourcemap: z
      .boolean()
      .default(true)
      .meta({ description: "Emit index.js.map and include it in the zip." }),
    minify: z.boolean().default(false).meta({ description: "Minify the bundle." }),
    external: z
      .array(z.string())
      .default([])
      .meta({ description: 'Packages to leave out of the bundle, e.g. "@aws-sdk/*".' }),
    define: z.record(z.string(), z.string()).default({}).meta({
      description:
        "esbuild define replacements. Values are code, so strings need inner quotes: '\"dev\"'.",
    }),
    copy: z
      .array(
        z
          .object({
            from: z
              .string()
              .trim()
              .min(1)
              .meta({ description: "File, directory, or glob, relative to the config file." }),
            to: z
              .string()
              .trim()
              .min(1)
              .meta({ description: "Destination relative to the zip root. Use . for the root." }),
          })
          .strict(),
      )
      .default([])
      .meta({ description: "Extra files to copy into the build output and zip." }),
    cache: z.boolean().default(true).meta({
      description:
        "Reuse the zip from an earlier build, by any target, with the same options and unchanged input files.",
    }),
    outDir: z.string().optional().meta({
      description:
        "Build output directory. Defaults to .lambda-dev/<target>. Cleared on every build.",
    }),
  })
  .strict()
  .meta({ description: "esbuild options for the handler bundle." });

const watchSchema = z
  .object({
    include: z
      .array(z.string())
      .default(["src/**/*"])
      .meta({ description: "Globs of files that trigger a deploy." }),
    exclude: z.array(z.string()).default(["node_modules/**", "dist/**", ".lambda-dev/**"]).meta({
      description: "Globs to ignore, even if included.",
    }),
    debounceMs: z
      .number()
      .int()
      .min(0)
      .default(300)
      .meta({ description: "Quiet period after the last change before deploying." }),
  })
  .strict()
  .default({
    include: ["src/**/*"],
    exclude: ["node_modules/**", "dist/**", ".lambda-dev/**"],
    debounceMs: 300,
  })
  .meta({ description: "File watching for the watch command." });

const expectSchema = z
  .object({
    statusCode: z.number().int().optional().meta({
      description: "Lambda's invoke status code, normally 200. Not the statusCode in your payload.",
    }),
    functionError: z.boolean().default(false).meta({
      description:
        "Whether the function should fail with an unhandled error (FunctionError). Default false.",
    }),
    payload: jsonValueSchema.optional().meta({
      description:
        "Expected response. Objects match if every listed key matches, so other keys are ignored; arrays and other values must be equal.",
    }),
    exact: z.boolean().default(false).meta({
      description: "Require the payload to equal the expected one exactly, with no extra keys.",
    }),
  })
  .strict()
  .meta({ description: "What a successful response looks like. The command fails otherwise." });

export type Expectation = z.infer<typeof expectSchema>;

const checkSchema = z
  .object({
    payloadFile: z
      .string()
      .optional()
      .meta({ description: "JSON event file, relative to the config file." }),
    payloadJson: jsonValueSchema
      .optional()
      .meta({ description: "Inline event. Takes priority over payloadFile." }),
    expect: expectSchema,
  })
  .strict()
  .meta({ description: "An invocation with a known event and an expected response." });

export type CheckConfig = z.infer<typeof checkSchema>;

const invokeSchema = z
  .object({
    afterDeploy: z
      .boolean()
      .default(false)
      .meta({ description: "Invoke after every deploy and watch cycle." }),
    payloadFile: z
      .string()
      .optional()
      .meta({ description: "JSON event file, relative to the config file." }),
    payloadJson: jsonValueSchema
      .optional()
      .meta({ description: "Inline event. Takes priority over payload files." }),
    logType: z
      .enum(["None", "Tail"])
      .default("Tail")
      .meta({ description: "Tail requests the last 4 KB of logs with the response." }),
    expect: expectSchema.optional(),
  })
  .strict()
  .default({
    afterDeploy: false,
    logType: "Tail",
  })
  .meta({ description: "Test invocation settings." });

const targetSchema = z
  .object({
    functionName: z
      .string()
      .min(1)
      .meta({ description: "Name or ARN of an existing Lambda function." }),
    region: z.string().min(1).meta({ description: "AWS region, e.g. eu-west-2." }),
    profile: z.string().min(1).optional().meta({
      description: "Named AWS profile. Without it, the default AWS SDK credential chain is used.",
    }),
    environment: z.record(environmentKey, z.string().nullable()).optional().meta({
      description:
        "Environment variables to set (string) or delete (null). Unlisted variables are left unchanged.",
    }),
    snapshot: z.boolean().default(true).meta({
      description:
        "Save the function's code and environment before the first deploy, so rollback can restore them.",
    }),
    build: buildSchema,
    watch: watchSchema,
    invoke: invokeSchema,
    checks: z
      .record(
        z
          .string()
          .regex(
            /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
            "Use letters, digits, dots, dashes, or underscores",
          ),
        checkSchema,
      )
      .default({})
      .meta({
        description:
          "Named checks, such as a health check, run by the check command and deploy --check.",
      }),
  })
  .strict()
  .meta({ description: "One Lambda function to build and deploy." });

export const configSchema = z
  .object({
    version: z.literal(1).meta({ description: "Config format version. Must be 1." }),
    defaultTarget: z
      .string()
      .optional()
      .meta({ description: "Target used when none is passed on the command line." }),
    targets: z
      .record(z.string().min(1), targetSchema)
      .refine((targets) => Object.keys(targets).length > 0, {
        message: "At least one target is required",
      })
      .meta({ description: "Map of target name to target settings.", minProperties: 1 }),
  })
  .strict()
  .meta({
    title: "aws-lambda-dev config",
    description: "Configuration for aws-lambda-dev (lambda-dev.yml).",
  });

export type RawConfig = z.infer<typeof configSchema>;

export type TargetConfig = z.infer<typeof targetSchema>;

export interface LoadedTarget {
  configPath: string;
  projectRoot: string;
  targetName: string;
  target: TargetConfig & {
    build: TargetConfig["build"] & { outDir: string };
  };
}

export async function loadConfig(configPath = "lambda-dev.yml"): Promise<RawConfig> {
  const absolutePath = path.resolve(configPath);
  let fileContents: string;

  try {
    fileContents = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new LambdaDevError("filesystem", `Unable to read config file ${absolutePath}`, {
      cause: error,
      hint: "Create lambda-dev.yml or pass --config with the config path.",
    });
  }

  let parsed: unknown;

  try {
    parsed = parse(fileContents, { merge: true, maxAliasCount: 100 });
  } catch (error) {
    // YAML parser messages may quote source lines containing environment values.
    const location = error instanceof YAMLParseError ? error.linePos?.[0] : undefined;

    const message = location
      ? `Invalid YAML at line ${location.line}, column ${location.col}`
      : "Invalid YAML or unresolved/invalid alias or merge (alias expansion is limited)";

    throw new LambdaDevError("validation", `Invalid YAML in ${absolutePath}: ${message}`);
  }

  const result = configSchema.safeParse(parsed);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");

    throw new LambdaDevError("validation", `Invalid config ${absolutePath}: ${details}`);
  }

  return result.data;
}

export async function loadTarget(
  configPath: string | undefined,
  targetName?: string,
): Promise<LoadedTarget> {
  const resolvedConfigPath = path.resolve(configPath ?? "lambda-dev.yml");
  const config = await loadConfig(resolvedConfigPath);
  const availableTargets = Object.keys(config.targets);

  const selectedName =
    targetName ??
    config.defaultTarget ??
    (availableTargets.length === 1 ? availableTargets[0] : undefined);

  if (!selectedName) {
    throw new LambdaDevError(
      "validation",
      `Target is required. Available targets: ${availableTargets.join(", ")}`,
    );
  }

  const target = config.targets[selectedName];

  if (!target) {
    throw new LambdaDevError(
      "validation",
      `Unknown target "${selectedName}". Available targets: ${availableTargets.join(", ")}`,
    );
  }

  const projectRoot = path.dirname(resolvedConfigPath);

  return {
    configPath: resolvedConfigPath,
    projectRoot,
    targetName: selectedName,
    target: {
      ...target,
      build: {
        ...target.build,
        outDir: target.build.outDir ?? path.join(".lambda-dev", selectedName),
      },
    },
  };
}
