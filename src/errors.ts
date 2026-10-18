export type ErrorCategory =
  | "validation"
  | "build"
  | "aws_deploy"
  | "aws_configuration"
  | "aws_snapshot"
  | "aws_invoke"
  | "filesystem"
  | "unexpected";

export class LambdaDevError extends Error {
  readonly category: ErrorCategory;
  readonly hint?: string;
  readonly cause?: unknown;

  constructor(
    category: ErrorCategory,
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "LambdaDevError";
    this.category = category;
    this.hint = options.hint;
    this.cause = options.cause;
  }
}

export function toLambdaDevError(
  category: ErrorCategory,
  message: string,
  cause: unknown,
): LambdaDevError {
  if (cause instanceof LambdaDevError) {
    return cause;
  }

  const detail = cause instanceof Error ? cause.message : String(cause);

  return new LambdaDevError(category, `${message}: ${detail}`, { cause });
}
