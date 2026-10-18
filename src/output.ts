import { inspect } from "node:util";
import { LambdaDevError } from "./errors.js";
import { parseJson, type JsonValue } from "./json.js";

const SECRET_KEY_PATTERN =
  /(access[_-]?key|secret|session[_-]?token|password|credential|authorization|api[_-]?key)/i;

const MAX_PREVIEW_CHARS = 2000;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const AWS_CREDENTIAL_ASSIGNMENT =
  /(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=[^\s"\\]+/g;

/** Replace values under secret-looking keys, and inline AWS credential assignments, with "[redacted]". */
export function redact(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value, (key, entry) =>
    SECRET_KEY_PATTERN.test(key) ? "[redacted]" : entry,
  );

  return parseJson(serialized.replace(AWS_CREDENTIAL_ASSIGNMENT, "$1=[redacted]"));
}

export function previewPayload(value: JsonValue | undefined, maxChars = MAX_PREVIEW_CHARS): string {
  const rendered = inspect(value === undefined ? value : redact(value), {
    depth: 6,
    colors: false,
  });

  if (rendered.length <= maxChars) {
    return rendered;
  }

  return `${rendered.slice(0, maxChars)}... [truncated ${rendered.length - maxChars} chars]`;
}

export function formatError(cause: unknown): string {
  if (cause instanceof LambdaDevError) {
    const hint = cause.hint ? `\nHint: ${cause.hint}` : "";

    return `[${cause.category}] ${cause.message}${hint}`;
  }

  if (cause instanceof Error) {
    return `[unexpected] ${cause.message}`;
  }

  return `[unexpected] ${String(cause)}`;
}

export function logStep(logger: Logger, targetName: string, step: string, message: string): void {
  logger.info(`[${targetName}] ${step}: ${message}`);
}
