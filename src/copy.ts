import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { glob, isDynamicPattern } from "tinyglobby";
import type { LoadedTarget } from "./config.js";

export interface CopyAsset {
  source: string;
  destination: string;
  mode: number;
  directory: boolean;
}

/** Resolve and validate the entire copy set before the build clears its output. */
export async function createCopyManifest(loaded: LoadedTarget): Promise<CopyAsset[]> {
  const entries = loaded.target.build.copy ?? [];
  if (entries.length === 0) return [];

  const root = await realpath(loaded.projectRoot);
  const output = path.resolve(root, loaded.target.build.outDir);
  await assertNoSymlinks(output);
  const assets = new Map<string, CopyAsset>();
  const parents = new Set<string>();
  const reserved = ["index.js", "index.js.map", "function.zip"];

  function add(source: string, destination: string, mode: number, directory: boolean): void {
    const name = destinationName(destination);
    if (name === ".") {
      if (directory) return;
      throw new Error(`Copy file ${source} requires a destination filename`);
    }
    for (const generated of reserved) {
      if (overlaps(name, generated)) {
        throw new Error(`Copy destination ${name} conflicts with generated file ${generated}`);
      }
    }
    if (assets.has(name)) throw new Error(`Duplicate copy destination ${name}`);
    if (!directory && parents.has(name)) {
      throw new Error(`Copy file/directory conflict at ${name}`);
    }
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (assets.get(parent)?.directory === false) {
        throw new Error(`Copy file/directory conflict at ${name} and ${parent}`);
      }
      parents.add(parent);
    }
    assets.set(name, { source, destination: name, mode, directory });
  }

  for (const entry of entries) {
    try {
      const destination = destinationName(entry.to);
      const source = path.resolve(root, entry.from);
      const info = await optionalStat(source);
      if (info) {
        await assertNoSymlinks(source);
        assertOutsideOutput(source, output, info.isDirectory());
        if (info.isFile()) {
          add(source, destination, info.mode, false);
        } else if (info.isDirectory()) {
          await walk(source, async (file, mode, directory) => {
            add(file, path.posix.join(destination, toUnix(path.relative(source, file))), mode, directory);
          });
        } else {
          throw new Error(`Unsupported copy source ${source}`);
        }
        continue;
      }

      const segments = entry.from.split(path.sep);
      const dynamic = segments.findIndex((segment) => isDynamicPattern(segment));
      if (dynamic === -1 || entry.from.startsWith("!")) {
        throw new Error(`Copy source does not exist: ${entry.from}`);
      }
      const base = path.resolve(root, segments.slice(0, dynamic).join(path.sep) || ".");
      const pattern = toUnix(segments.slice(dynamic).join(path.sep));
      await assertNoSymlinks(base);
      assertOutsideOutput(base, output, true);
      // Validate the scanned tree without following links; glob libraries can silently skip links.
      await walk(base, async () => {});
      const matches = await glob(pattern, {
        cwd: base,
        onlyFiles: true,
        expandDirectories: false,
        followSymbolicLinks: false,
      });
      if (matches.length === 0) throw new Error(`Copy pattern matched no files: ${entry.from}`);
      for (const match of matches.sort()) {
        const file = path.resolve(base, match);
        if (!contains(base, file)) {
          throw new Error(`Copy glob must stay inside its non-glob base: ${entry.from}`);
        }
        assertOutsideOutput(file, output, false);
        const info = await lstat(file);
        add(file, path.posix.join(destination, toUnix(match)), info.mode, false);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to copy ${entry.from} to ${entry.to}: ${detail}`, { cause: error });
    }
  }
  return [...assets.values()].sort((a, b) => a.destination.localeCompare(b.destination));
}

function destinationName(value: string): string {
  const unix = value.replaceAll("\\", "/");
  if (!unix.trim() || path.posix.isAbsolute(unix) || path.win32.isAbsolute(value) ||
      /^[a-z]:/i.test(value) || unix.split("/").includes("..") || unix.includes("\0")) {
    throw new Error(`Copy destination must stay inside the build output: ${value}`);
  }
  return path.posix.normalize(unix).replace(/\/$/, "");
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertOutsideOutput(source: string, output: string, directory: boolean): void {
  if (contains(output, source) || (directory && contains(source, output))) {
    throw new Error(`Copy source ${source} overlaps build output ${output}`);
  }
}

async function assertNoSymlinks(file: string): Promise<void> {
  const parsed = path.parse(file);
  let current = parsed.root;
  for (const segment of file.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, segment);
    const info = await optionalStat(current);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported in copy paths: ${current}`);
  }
}

async function optionalStat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function walk(
  file: string,
  visit: (file: string, mode: number, directory: boolean) => Promise<void>,
): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported in copy sources: ${file}`);
  if (!info.isFile() && !info.isDirectory()) throw new Error(`Unsupported copy source ${file}`);
  await visit(file, info.mode, info.isDirectory());
  if (info.isDirectory()) {
    for (const name of (await readdir(file)).sort()) await walk(path.join(file, name), visit);
  }
}

function toUnix(value: string): string {
  return value.split(path.sep).join("/");
}
