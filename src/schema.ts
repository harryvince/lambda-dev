import { z } from "zod";
import { configSchema } from "./config.js";

export const CONFIG_SCHEMA_URL = "https://harryvince.github.io/lambda-dev/schema.json";

/** JSON Schema for lambda-dev.yml, generated from the zod schema the CLI validates with. */
export function createConfigJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(configSchema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  });
  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema };
}
