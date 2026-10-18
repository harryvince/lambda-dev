import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { version as esbuildVersion } from "esbuild";
import { z } from "zod";
import type { LoadedTarget } from "./config.js";
import type { CopyAsset } from "./copy.js";
import { LambdaDevError } from "./errors.js";
import { parseJson } from "./json.js";

/** Bump when the build output changes for the same inputs, so older entries stop matching. */
const CACHE_FORMAT = 1;
const MANIFEST_FILE = "manifest.json";
const ARTIFACT_FILE = "function.zip";
const MAX_ENTRIES = 20;
const HASH_CONCURRENCY = 64;

/**
 * Files esbuild reads while resolving imports without listing them as inputs. Their contents go
 * into the key, so installing packages or changing tsconfig paths invalidates the cache.
 */
const PROJECT_FILES = [
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
];

const manifestSchema = z.object({
  version: z.literal(CACHE_FORMAT),
  key: z.string(),
  artifactSha256: z.string(),
  /** Absolute path to SHA-256 of every file the build read: esbuild inputs and copied files. */
  inputs: z.record(z.string(), z.string()),
});

type CacheManifest = z.infer<typeof manifestSchema>;

export function buildCacheRoot(projectRoot: string): string {
  return path.join(projectRoot, ".lambda-dev", "build-cache");
}

/** Every build clears outDir, so it can't hold the cache, and the cache can't hold it. */
export function assertOutDirKeepsBuildCache(loaded: LoadedTarget): void {
  const outDir = path.resolve(loaded.projectRoot, loaded.target.build.outDir);
  const cacheRoot = buildCacheRoot(loaded.projectRoot);

  if (isWithin(outDir, cacheRoot) || isWithin(cacheRoot, outDir)) {
    throw new LambdaDevError(
      "validation",
      `build.outDir ${outDir} overlaps the build cache in ${cacheRoot}`,
      { hint: "Choose a build.outDir outside .lambda-dev/build-cache, or set build.cache: false." },
    );
  }
}

/**
 * Hash everything known before the build: the build options, the copy layout, and the project
 * files that affect module resolution. Targets with the same key share one cache entry.
 */
export async function computeBuildCacheKey(
  loaded: LoadedTarget,
  assets: CopyAsset[],
): Promise<string> {
  const { outDir: _outDir, copy: _copy, cache: _cache, ...options } = loaded.target.build;
  const projectFiles: Record<string, string | null> = {};

  for (const file of projectFileCandidates(loaded.projectRoot)) {
    projectFiles[file] = await hashFileIfPresent(file);
  }

  const material = {
    format: CACHE_FORMAT,
    esbuild: esbuildVersion,
    projectRoot: loaded.projectRoot,
    entry: path.resolve(loaded.projectRoot, options.entry),
    options,
    copy: assets.map((asset) => [asset.source, asset.destination, asset.mode, asset.directory]),
    projectFiles,
  };

  return sha256Hex(JSON.stringify(material));
}

/** Return the cached zip for this key if every recorded input still has the same contents. */
export async function readBuildCache(
  projectRoot: string,
  key: string,
): Promise<Uint8Array | undefined> {
  const directory = path.join(buildCacheRoot(projectRoot), key);
  let manifest: CacheManifest;

  try {
    manifest = manifestSchema.parse(
      parseJson(await readFile(path.join(directory, MANIFEST_FILE), "utf8")),
    );
  } catch {
    // Missing, partially written, or from another format: rebuild.
    return undefined;
  }

  if (manifest.key !== key) return undefined;

  const current = await hashFiles(Object.keys(manifest.inputs));

  for (const [file, hash] of Object.entries(manifest.inputs)) {
    if (current.get(file) !== hash) return undefined;
  }

  try {
    const artifact = await readFile(path.join(directory, ARTIFACT_FILE));

    return sha256Hex(artifact) === manifest.artifactSha256 ? artifact : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store a freshly built zip with the hashes of the files it was built from. Best effort: a cache
 * that can't be written only costs the next build its speed-up.
 */
export async function writeBuildCache(
  projectRoot: string,
  key: string,
  artifact: Uint8Array,
  inputFiles: string[],
): Promise<void> {
  const root = buildCacheRoot(projectRoot);
  const directory = path.join(root, key);
  const staging = path.join(root, `${key}.tmp-${randomUUID()}`);

  try {
    const hashes = await hashFiles(inputFiles);
    const inputs: Record<string, string> = {};

    for (const file of inputFiles) {
      const hash = hashes.get(file);

      // An input esbuild didn't read from disk can't be verified later, so don't cache.
      if (hash === undefined) return;
      inputs[file] = hash;
    }

    const manifest: CacheManifest = {
      version: CACHE_FORMAT,
      key,
      artifactSha256: sha256Hex(artifact),
      inputs,
    };

    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, ARTIFACT_FILE), artifact);
    await writeFile(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
    // Swap the whole entry in, so concurrent readers see the old entry, the new one, or none.
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
    await pruneBuildCache(root, key);
  } catch {
    // Another process may have won the rename; either way the build itself succeeded.
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Keep the most recently written entries so old option sets and lockfiles don't pile up. */
async function pruneBuildCache(root: string, keep: string): Promise<void> {
  const entries: { name: string; mtimeMs: number }[] = [];

  for (const name of await readdir(root)) {
    if (name === keep || name.includes(".tmp-")) continue;

    const info = await stat(path.join(root, name)).catch(() => undefined);

    if (info?.isDirectory()) entries.push({ name, mtimeMs: info.mtimeMs });
  }

  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const entry of entries.slice(MAX_ENTRIES - 1)) {
    await rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

function projectFileCandidates(projectRoot: string): string[] {
  const files: string[] = [];

  for (let directory = projectRoot; ; directory = path.dirname(directory)) {
    for (const name of PROJECT_FILES) files.push(path.join(directory, name));

    if (path.dirname(directory) === directory) return files;
  }
}

/** Hash files in bounded batches; unreadable files are left out of the result. */
async function hashFiles(files: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (let start = 0; start < files.length; start += HASH_CONCURRENCY) {
    const batch = files.slice(start, start + HASH_CONCURRENCY);
    const results = await Promise.all(batch.map((file) => hashFileIfPresent(file)));

    batch.forEach((file, index) => {
      const hash = results[index];

      if (hash !== null && hash !== undefined) hashes.set(file, hash);
    });
  }

  return hashes;
}

async function hashFileIfPresent(file: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(file));
  } catch {
    return null;
  }
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
