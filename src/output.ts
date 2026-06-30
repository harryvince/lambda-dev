import { inspect } from "node:util";
import { LambdaDevError } from "./errors.js";

const SECRET_KEY_PATTERN = /(access[_-]?key|secret|session[_-]?token|password|credential|authorization|api[_-]?key)/i;
const MAX_PREVIEW_CHARS = 2000;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message)
};

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(entry);
    }
    return redacted;
  }

  if (typeof value === "string") {
    return value.replace(/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=\S+/g, "$1=[redacted]");
  }

  return value;
}

export function previewPayload(value: unknown, maxChars = MAX_PREVIEW_CHARS): string {
  const redacted = redact(value);
  const rendered = typeof redacted === "string" ? redacted : inspect(redacted, { depth: 6, colors: false });

  if (rendered.length <= maxChars) {
    return rendered;
  }

  return `${rendered.slice(0, maxChars)}... [truncated ${rendered.length - maxChars} chars]`;
}

export function formatError(error: unknown): string {
  if (error instanceof LambdaDevError) {
    const hint = error.hint ? `\nHint: ${error.hint}` : "";
    return `[${error.category}] ${error.message}${hint}`;
  }

  if (error instanceof Error) {
    return `[unexpected] ${error.message}`;
  }

  return `[unexpected] ${String(error)}`;
}

export function logStep(logger: Logger, targetName: string, step: string, message: string): void {
  logger.info(`[${targetName}] ${step}: ${message}`);
}
