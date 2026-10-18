import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createConfigJsonSchema, CONFIG_SCHEMA_URL } from "../src/schema.js";

describe("config JSON Schema", () => {
  it("matches the committed docs/schema.json", async () => {
    const committed = JSON.parse(await readFile(new URL("../docs/schema.json", import.meta.url), "utf8"));
    // If this fails after changing src/config.ts, run `mise run schema` and commit the result.
    expect(committed).toEqual(createConfigJsonSchema());
  });

  it("is published at the URL used in config examples", () => {
    expect(createConfigJsonSchema().$id).toBe(CONFIG_SCHEMA_URL);
  });
});
