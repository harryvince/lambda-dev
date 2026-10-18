import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { build as esbuild } from "esbuild";
import {
  assertOutDirKeepsBuildCache,
  computeBuildCacheKey,
  readBuildCache,
  writeBuildCache,
} from "./cache.js";
import { toLambdaDevError } from "./errors.js";
import type { LoadedTarget } from "./config.js";
import { createCopyManifest } from "./copy.js";

export interface BuildResult {
  artifactPath: string;
  artifactBytes: Uint8Array;
  sizeBytes: number;
  durationMs: number;
  /** True when the zip came from the build cache instead of a fresh build. */
  cached: boolean;
}

export async function buildArtifact(loaded: LoadedTarget): Promise<BuildResult> {
  const started = Date.now();
  const outDir = path.resolve(loaded.projectRoot, loaded.target.build.outDir);
  const bundlePath = path.join(outDir, "index.js");
  const artifactPath = path.join(outDir, "function.zip");

  try {
    const assets = await createCopyManifest(loaded);
    let cacheKey: string | undefined;

    if (loaded.target.build.cache) {
      assertOutDirKeepsBuildCache(loaded);
      cacheKey = await computeBuildCacheKey(loaded, assets);
    }

    const cachedArtifact = cacheKey
      ? await readBuildCache(loaded.projectRoot, cacheKey)
      : undefined;

    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    if (cachedArtifact) {
      await extractArtifact(cachedArtifact, outDir);
      await writeFile(artifactPath, cachedArtifact);

      return {
        artifactPath,
        artifactBytes: cachedArtifact,
        sizeBytes: cachedArtifact.byteLength,
        durationMs: Date.now() - started,
        cached: true,
      };
    }

    const { metafile } = await esbuild({
      absWorkingDir: loaded.projectRoot,
      metafile: true,
      entryPoints: [path.resolve(loaded.projectRoot, loaded.target.build.entry)],
      bundle: loaded.target.build.bundle,
      platform: loaded.target.build.platform,
      target: loaded.target.build.target,
      format: loaded.target.build.format,
      sourcemap: loaded.target.build.sourcemap,
      minify: loaded.target.build.minify,
      external: loaded.target.build.external,
      define: loaded.target.build.define,
      outfile: bundlePath,
    });

    const zip = new AdmZip();
    zip.addLocalFile(bundlePath, "", "index.js");

    const sourceMapPath = `${bundlePath}.map`;

    if (await exists(sourceMapPath)) {
      zip.addLocalFile(sourceMapPath, "", "index.js.map");
    }

    for (const asset of assets) {
      const destination = path.join(outDir, asset.destination);

      if (asset.directory) {
        await mkdir(destination, { recursive: true });
        zip.addFile(`${asset.destination}/`, Buffer.alloc(0), "", asset.mode & 0o777);
      } else {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(asset.source, destination);
        await chmod(destination, asset.mode & 0o777);
        zip.addFile(asset.destination, await readFile(destination), "", asset.mode & 0o777);
      }
    }

    // Apply directory modes after writing children so read-only sources can be copied too.
    for (const asset of assets.filter((asset) => asset.directory).reverse()) {
      await chmod(path.join(outDir, asset.destination), asset.mode & 0o777);
    }

    zip.writeZip(artifactPath);
    const artifactBytes = await readFile(artifactPath);

    if (cacheKey) {
      const inputs = [
        ...Object.keys(metafile.inputs).map((input) => path.resolve(loaded.projectRoot, input)),
        ...assets.filter((asset) => !asset.directory).map((asset) => asset.source),
      ];

      await writeBuildCache(loaded.projectRoot, cacheKey, artifactBytes, inputs);
    }

    return {
      artifactPath,
      artifactBytes,
      sizeBytes: artifactBytes.byteLength,
      durationMs: Date.now() - started,
      cached: false,
    };
  } catch (error) {
    throw toLambdaDevError("build", `Build failed for target ${loaded.targetName}`, error);
  }
}

/** Recreate the build output from a cached zip, so outDir looks the same as after a fresh build. */
async function extractArtifact(artifact: Uint8Array, outDir: string): Promise<void> {
  const directories: { destination: string; mode: number }[] = [];

  for (const entry of new AdmZip(Buffer.from(artifact)).getEntries()) {
    const destination = path.resolve(outDir, entry.entryName);
    const relative = path.relative(outDir, destination);

    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Cached artifact has an unsafe entry ${entry.entryName}`);
    }

    const mode = (entry.attr >>> 16) & 0o777;

    if (entry.isDirectory) {
      await mkdir(destination, { recursive: true });
      directories.push({ destination, mode });
    } else {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, entry.getData());

      if (mode !== 0) await chmod(destination, mode);
    }
  }

  // As in a fresh build, directory modes go on last so read-only directories can be filled.
  for (const directory of directories.reverse()) {
    if (directory.mode !== 0) await chmod(directory.destination, directory.mode);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);

    return true;
  } catch {
    return false;
  }
}
