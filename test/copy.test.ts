import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadTarget } from "../src/config.js";
import { createCopyManifest } from "../src/copy.js";
import { buildArtifact } from "../src/build.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(copy: Array<{ from: string; to: string }>, outDir = "out") {
  const root = await mkdtemp(path.join(os.tmpdir(), "lambda-copy-"));
  roots.push(root);
  await mkdir(path.join(root, "assets/nested"), { recursive: true });
  await writeFile(path.join(root, "assets/nested/data.json"), '{"ok":true}');
  await writeFile(path.join(root, "assets/.hidden"), "hidden");
  await writeFile(path.join(root, "handler.ts"), "export const handler = () => true;");
  const config = path.join(root, "lambda-dev.yml");
  await writeFile(config, stringify({ version: 1, targets: { dev: {
    functionName: "test", region: "eu-west-2", build: { entry: "handler.ts", copy, outDir },
  } } }));
  return { root, loaded: await loadTarget(config) };
}

describe("copy manifest preflight", () => {
  it("resolves config-relative files, directory trees, empty directories, and dotfiles", async () => {
    const { root, loaded } = await fixture([{ from: "assets", to: "runtime" }]);
    await mkdir(path.join(root, "assets/empty"));
    const assets = await createCopyManifest(loaded);
    expect(assets.map((asset) => asset.destination)).toEqual([
      "runtime", "runtime/.hidden", "runtime/empty", "runtime/nested", "runtime/nested/data.json",
    ]);
    expect(assets.find((asset) => asset.destination.endsWith("data.json"))?.source).toBe(
      path.join(await realpath(root), "assets/nested/data.json"),
    );
  });

  it("supports renaming an absolute file source", async () => {
    const { root, loaded } = await fixture([]);
    const source = path.join(await realpath(root), "assets/.hidden");
    loaded.target.build.copy = [{ from: source, to: "runtime/renamed.txt" }];
    expect(await createCopyManifest(loaded)).toMatchObject([{
      source, destination: "runtime/renamed.txt", directory: false,
    }]);
  });

  it("keeps glob paths relative to their non-glob base and supports explicit dotfiles", async () => {
    const { loaded } = await fixture([
      { from: "assets/**/*.json", to: "." },
      { from: "assets/.*", to: "hidden" },
    ]);
    expect((await createCopyManifest(loaded)).map((asset) => asset.destination)).toEqual([
      "hidden/.hidden", "nested/data.json",
    ]);
  });

  it("supports brace patterns", async () => {
    const { loaded } = await fixture([{ from: "assets/**/*.{json,txt}", to: "data" }]);
    expect((await createCopyManifest(loaded)).map((asset) => asset.destination)).toEqual(["data/nested/data.json"]);
  });

  it.each(["missing.bin", "assets/**/*.missing"])("fails for missing input %s", async (from) => {
    const { loaded } = await fixture([{ from, to: "data" }]);
    await expect(buildArtifact(loaded)).rejects.toMatchObject({ category: "build", message: expect.stringContaining(from) });
  });

  it.each(["../escape", "nested/../../escape", "/absolute", "C:\\escape", "\\\\server\\share", "..\\escape", "C:escape"])(
    "rejects unsafe destination %s before clearing output", async (to) => {
      const { root, loaded } = await fixture([{ from: "assets/.hidden", to }]);
      await mkdir(path.join(root, "out"));
      await writeFile(path.join(root, "out/sentinel"), "keep");
      await expect(buildArtifact(loaded)).rejects.toMatchObject({ category: "build" });
      expect(await readFile(path.join(root, "out/sentinel"), "utf8")).toBe("keep");
    },
  );

  it.each(["index.js", "index.js/child", "index.js.map", "function.zip", "function.zip/child"])(
    "rejects generated destination %s", async (to) => {
      const { loaded } = await fixture([{ from: "assets/.hidden", to }]);
      await expect(createCopyManifest(loaded)).rejects.toThrow("conflicts with generated");
    },
  );

  it.each([
    [{ from: "assets/.hidden", to: "same" }, { from: "assets/nested/data.json", to: "same" }],
    [{ from: "assets/.hidden", to: "data" }, { from: "assets/nested/data.json", to: "data/child" }],
    [{ from: "assets/nested/data.json", to: "data/child" }, { from: "assets/.hidden", to: "data" }],
  ])("rejects duplicate and file/directory collisions: %j", async (...copy) => {
    const { loaded } = await fixture(copy);
    await expect(createCopyManifest(loaded)).rejects.toThrow(/Duplicate|conflict/);
  });

  it.each([".", "out/file", "assets/**/*"])("rejects recursive output input %s", async (from) => {
    const { root, loaded } = await fixture([{ from, to: "runtime" }], "assets/output");
    if (from === "out/file") {
      loaded.target.build.copy = [{ from: "assets/output/file", to: "runtime" }];
      await mkdir(path.join(root, "assets/output"));
      await writeFile(path.join(root, "assets/output/file"), "output");
    }
    await expect(createCopyManifest(loaded)).rejects.toThrow("overlaps build output");
  });

  it.each(["link", "link/nested/data.json", "assets", "assets/**/*"])("rejects source symlinks for %s", async (from) => {
    const { root, loaded } = await fixture([{ from, to: "runtime" }]);
    await symlink(path.join(root, "assets"), path.join(root, "link"));
    await symlink(path.join(root, "handler.ts"), path.join(root, "assets/linked-file"));
    await expect(createCopyManifest(loaded)).rejects.toThrow("Symbolic links");
  });

  it("rejects symlinked output parents before writing outside output", async () => {
    const { root, loaded } = await fixture([{ from: "assets/.hidden", to: "data" }], "linked/out");
    await symlink(path.join(root, "assets"), path.join(root, "linked"));
    await expect(buildArtifact(loaded)).rejects.toMatchObject({ category: "build", message: expect.stringContaining("Symbolic links") });
  });

  it("requires a filename when copying a single file", async () => {
    const { loaded } = await fixture([{ from: "assets/.hidden", to: "." }]);
    await expect(createCopyManifest(loaded)).rejects.toThrow("destination filename");
  });
});
