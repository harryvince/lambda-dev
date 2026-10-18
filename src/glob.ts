import path from "node:path";

const GLOB_SYNTAX = /[*?[\]{}]/;

/** Whether a single path segment contains glob syntax. */
export function hasGlobSyntax(segment: string): boolean {
  return GLOB_SYNTAX.test(segment);
}

/**
 * Split a POSIX-style pattern into the literal directory before its first glob segment and the rest.
 * A pattern without glob syntax has a null glob.
 */
export function splitGlob(pattern: string): { base: string; glob: string | null } {
  const segments = pattern.split("/");
  const firstGlob = segments.findIndex(hasGlobSyntax);

  if (firstGlob === -1) {
    return { base: path.posix.dirname(pattern), glob: null };
  }

  return {
    base: segments.slice(0, firstGlob).join("/") || ".",
    glob: segments.slice(firstGlob).join("/"),
  };
}

export function toUnixPath(value: string): string {
  return value.split(path.sep).join("/");
}
