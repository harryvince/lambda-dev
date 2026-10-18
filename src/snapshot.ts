import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LoadedTarget } from "./config.js";
import { LambdaDevError } from "./errors.js";
import { parseJson } from "./json.js";

/** A function's code and environment as read from Lambda. */
export interface FunctionState {
  code: Uint8Array;
  /** Base64 SHA-256 of the code zip, in Lambda's CodeSha256 format. */
  codeSha256: string;
  environment: Record<string, string>;
}

const snapshotMetadataSchema = z.object({
  version: z.literal(1),
  functionName: z.string(),
  region: z.string(),
  createdAt: z.string(),
  codeSha256: z.string(),
  environment: z.record(z.string(), z.string()),
});

export type SnapshotMetadata = z.infer<typeof snapshotMetadataSchema>;

export interface Snapshot extends SnapshotMetadata {
  code: Uint8Array;
  directory: string;
}

const METADATA_FILE = "snapshot.json";
const CODE_FILE = "code.zip";

export function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

export function snapshotRoot(projectRoot: string): string {
  return path.join(projectRoot, ".lambda-dev", "snapshots");
}

/** Snapshots are keyed by function, so targets that share a function share its snapshot. */
export function snapshotDirectory(loaded: LoadedTarget): string {
  return path.join(
    snapshotRoot(loaded.projectRoot),
    toPathSegment(loaded.target.region),
    toPathSegment(loaded.target.functionName),
  );
}

/** Every build clears outDir, so it must not contain the snapshots. */
export function assertOutDirKeepsSnapshots(loaded: LoadedTarget): void {
  const outDir = path.resolve(loaded.projectRoot, loaded.target.build.outDir);
  const relative = path.relative(outDir, snapshotRoot(loaded.projectRoot));

  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new LambdaDevError(
      "validation",
      `build.outDir ${outDir} contains the rollback snapshots, which every build deletes`,
      {
        hint: "Choose a build.outDir outside .lambda-dev/snapshots, or set snapshot: false on the target.",
      },
    );
  }
}

export async function hasSnapshot(loaded: LoadedTarget): Promise<boolean> {
  try {
    await access(path.join(snapshotDirectory(loaded), METADATA_FILE));

    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function writeSnapshot(
  loaded: LoadedTarget,
  state: FunctionState,
  now = new Date(),
): Promise<string> {
  const directory = snapshotDirectory(loaded);

  const metadata: SnapshotMetadata = {
    version: 1,
    functionName: loaded.target.functionName,
    region: loaded.target.region,
    createdAt: now.toISOString(),
    codeSha256: state.codeSha256,
    environment: state.environment,
  };

  try {
    // The environment may hold secrets, so keep the snapshot private to the current user.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, CODE_FILE), state.code, { mode: 0o600 });
    // The metadata is written last: a snapshot only exists once it's complete.
    await writeFile(path.join(directory, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new LambdaDevError("filesystem", `Unable to save the rollback snapshot in ${directory}`, {
      cause: error,
      hint: "Nothing was changed in AWS. Check that the project directory is writable.",
    });
  }

  return directory;
}

export async function readSnapshot(loaded: LoadedTarget): Promise<Snapshot | undefined> {
  const directory = snapshotDirectory(loaded);
  let rawMetadata: string;

  try {
    rawMetadata = await readFile(path.join(directory, METADATA_FILE), "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw corrupted(directory, error);
  }

  let metadata: SnapshotMetadata;
  let code: Uint8Array;

  try {
    metadata = snapshotMetadataSchema.parse(parseJson(rawMetadata));
    code = await readFile(path.join(directory, CODE_FILE));
  } catch (error) {
    throw corrupted(directory, error);
  }

  if (sha256Base64(code) !== metadata.codeSha256) {
    throw corrupted(directory, undefined);
  }

  return { ...metadata, code, directory };
}

export async function deleteSnapshot(loaded: LoadedTarget): Promise<void> {
  await rm(snapshotDirectory(loaded), { recursive: true, force: true });
}

function corrupted(directory: string, cause: unknown): LambdaDevError {
  return new LambdaDevError("filesystem", `The rollback snapshot in ${directory} is unreadable`, {
    cause,
    hint: "Nothing was changed in AWS. The snapshot can't be used; delete the directory to let the next deploy take a fresh one.",
  });
}

function toPathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, "_");

  return segment === "." || segment === ".." ? `_${segment}` : segment;
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
