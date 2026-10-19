import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "../src/json.js";

// Each hook's rev, from its [[repos]] entry in prek.toml.
const HOOK_REVS = {
  oxlint: /mirrors-oxlint"\s*\nrev = "v([^"]+)"/,
  oxfmt: /mirrors-oxfmt"\s*\nrev = "v([^"]+)"/,
};

const packageSchema = z.object({ devDependencies: z.record(z.string(), z.string()) });

describe("tool versions", () => {
  it.each(["oxlint", "oxfmt"] as const)(
    "pins the %s hook to the package.json version",
    async (tool) => {
      const prekConfig = await readFile(new URL("../prek.toml", import.meta.url), "utf8");

      const packageJson = packageSchema.parse(
        parseJson(await readFile(new URL("../package.json", import.meta.url), "utf8")),
      );

      const hookRev = HOOK_REVS[tool].exec(prekConfig)?.[1];

      // If this fails, update the rev in prek.toml and the version in package.json together.
      expect(hookRev).toBe(packageJson.devDependencies[tool]);
    },
  );
});
