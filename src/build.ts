import { chmod, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { build as esbuild } from "esbuild";
import { toLambdaDevError } from "./errors.js";
import type { LoadedTarget } from "./config.js";
import { createCopyManifest } from "./copy.js";

export interface BuildResult {
  artifactPath: string;
  artifactBytes: Uint8Array;
  sizeBytes: number;
  durationMs: number;
}

export async function buildArtifact(loaded: LoadedTarget): Promise<BuildResult> {
  const started = Date.now();
  const outDir = path.resolve(loaded.projectRoot, loaded.target.build.outDir);
  const bundlePath = path.join(outDir, "index.js");
  const artifactPath = path.join(outDir, "function.zip");

  try {
    const assets = await createCopyManifest(loaded);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    await esbuild({
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

    return {
      artifactPath,
      artifactBytes,
      sizeBytes: artifactBytes.byteLength,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    throw toLambdaDevError("build", `Build failed for target ${loaded.targetName}`, error);
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
