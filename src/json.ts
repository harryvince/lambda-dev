import { z } from "zod";

export const jsonValueSchema = z.json();

export type JsonValue = z.infer<typeof jsonValueSchema>;

/** Parse JSON text into a value that's known to be JSON-compatible. */
export function parseJson(text: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(text));
}
