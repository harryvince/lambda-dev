import { z } from "zod";
import type { InvokeResult } from "./aws.js";
import type { Expectation } from "./config.js";
import { jsonValueSchema, type JsonValue } from "./json.js";
import { isSecretKey, previewPayload } from "./output.js";

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/** Describe every way an invoke result differs from the expectation; empty when it matches. */
export function findMismatches(expectation: Expectation, result: InvokeResult): string[] {
  const mismatches: string[] = [];

  if (expectation.statusCode !== undefined && result.statusCode !== expectation.statusCode) {
    mismatches.push(
      `status code: expected ${expectation.statusCode}, received ${result.statusCode ?? "none"}`,
    );
  }

  if (!expectation.functionError && result.functionError) {
    mismatches.push(`function error: ${result.functionError}`);
  }

  if (expectation.functionError && !result.functionError) {
    mismatches.push("function error: expected one, received none");
  }

  if (expectation.payload !== undefined) {
    compare(expectation.payload, result.payload, ["payload"], expectation.exact, mismatches);
  }

  return mismatches;
}

function compare(
  expected: JsonValue,
  actual: JsonValue | undefined,
  location: string[],
  exact: boolean,
  mismatches: string[],
): void {
  const expectedObject = jsonObjectSchema.safeParse(expected);

  if (expectedObject.success) {
    const actualObject = jsonObjectSchema.safeParse(actual);

    if (!actualObject.success) {
      mismatches.push(differs(location, expected, actual));

      return;
    }

    for (const [key, value] of Object.entries(expectedObject.data)) {
      compare(value, actualObject.data[key], [...location, key], exact, mismatches);
    }

    if (exact) {
      for (const key of Object.keys(actualObject.data)) {
        if (!(key in expectedObject.data)) {
          mismatches.push(`${formatLocation([...location, key])}: unexpected`);
        }
      }
    }

    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      mismatches.push(differs(location, expected, actual));

      return;
    }

    expected.forEach((value, index) => {
      compare(value, actual[index], [...location, String(index)], exact, mismatches);
    });

    return;
  }

  if (actual !== expected) {
    mismatches.push(differs(location, expected, actual));
  }
}

function differs(location: string[], expected: JsonValue, actual: JsonValue | undefined): string {
  const where = formatLocation(location);

  // Responses can carry secrets, and the redaction in previewPayload only sees keys inside the value.
  if (location.some(isSecretKey)) {
    return `${where}: doesn't match the expected value`;
  }

  return `${where}: expected ${previewPayload(expected, 200)}, received ${actual === undefined ? "nothing" : previewPayload(actual, 200)}`;
}

function formatLocation(location: string[]): string {
  return location
    .map((part, index) =>
      index === 0
        ? part
        : /^\d+$/.test(part)
          ? `[${part}]`
          : /^[A-Za-z_$][\w$]*$/.test(part)
            ? `.${part}`
            : `[${JSON.stringify(part)}]`,
    )
    .join("");
}
