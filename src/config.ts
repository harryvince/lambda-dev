import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { LambdaDevError } from "./errors.js";

const buildSchema = z
  .object({
    entry: z.string().min(1),
    bundle: z.boolean().default(true),
    platform: z.enum(["node", "browser", "neutral"]).default("node"),
    target: z.string().default("node20"),
    format: z.enum(["cjs", "esm", "iife"]).default("cjs"),
    sourcemap: z.boolean().default(true),
    minify: z.boolean().default(false),
    external: z.array(z.string()).default([]),
    define: z.record(z.string(), z.string()).default({}),
    copy: z.array(z.object({
      from: z.string().trim().min(1),
      to: z.string().trim().min(1),
    }).strict()).default([]),
    outDir: z.string().optional(),
  })
  .strict();

const watchSchema = z
  .object({
    include: z.array(z.string()).default(["src/**/*"]),
    exclude: z.array(z.string()).default(["node_modules/**", "dist/**", ".lambda-dev/**"]),
    debounceMs: z.number().int().min(0).default(300),
  })
  .strict()
  .default({
    include: ["src/**/*"],
    exclude: ["node_modules/**", "dist/**", ".lambda-dev/**"],
    debounceMs: 300,
  });

const invokeSchema = z
  .object({
    afterDeploy: z.boolean().default(false),
    payloadFile: z.string().optional(),
    payloadJson: z.unknown().optional(),
    logType: z.enum(["None", "Tail"]).default("Tail"),
  })
  .strict()
  .default({
    afterDeploy: false,
    logType: "Tail",
  });

const targetSchema = z
  .object({
    functionName: z.string().min(1),
    region: z.string().min(1),
    profile: z.string().min(1).optional(),
    build: buildSchema,
    watch: watchSchema,
    invoke: invokeSchema,
  })
  .strict();

const configSchema = z
  .object({
    version: z.literal(1),
    defaultTarget: z.string().optional(),
    targets: z
      .record(z.string().min(1), targetSchema)
      .refine((targets) => Object.keys(targets).length > 0, {
        message: "At least one target is required",
      }),
  })
  .strict();

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
    const message = error instanceof Error ? error.message : "Invalid YAML";
    throw new LambdaDevError("validation", `Invalid YAML in ${absolutePath}: ${message}`, {
      cause: error,
    });
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
