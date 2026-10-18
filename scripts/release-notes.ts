import { readFile } from "node:fs/promises";
import { z } from "zod";

// Prints the CHANGELOG.md section for the current package.json version, for `gh release create`.

const packageSchema = z.object({ version: z.string().min(1) });

const packageJson = packageSchema.parse(
  JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")),
);

const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = changelog.split("\n");
const isVersionHeading = (line: string) => /^#{2,3} \[/.test(line);

const start = lines.findIndex(
  (line) => isVersionHeading(line) && line.includes(`[${packageJson.version}]`),
);

if (start === -1) {
  throw new Error(`CHANGELOG.md has no section for ${packageJson.version}`);
}

const nextHeading = lines.findIndex((line, index) => index > start && isVersionHeading(line));
const section = lines.slice(start + 1, nextHeading === -1 ? undefined : nextHeading);

console.log(
  section
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim(),
);
