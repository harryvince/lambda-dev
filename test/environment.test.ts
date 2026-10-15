import { describe, expect, it } from "vitest";
import { applyEnvironmentPatch } from "../src/environment.js";

describe("environment patch", () => {
  it("preserves unrelated variables, sets literal strings/empty values, deletes only explicit nulls", () => {
    const existing = { KEEP: "retained", CHANGE: "old", REMOVE: "delete me" };
    const { variables, result } = applyEnvironmentPatch(existing, {
      CHANGE: "new", REMOVE: null, EMPTY: "", LITERAL: "${LOCAL_VALUE}",
    });
    expect(variables).toEqual({ KEEP: "retained", CHANGE: "new", EMPTY: "", LITERAL: "${LOCAL_VALUE}" });
    expect(result).toEqual({ changed: true, updatedCount: 3, deletedCount: 1 });
    expect(existing).toEqual({ KEEP: "retained", CHANGE: "old", REMOVE: "delete me" });
  });

  it("skips changes for already matching values or absent deletions", () => {
    expect(applyEnvironmentPatch({ AA: "a", BB: "b" }, { BB: "b", AA: "a", MISSING: null }).result)
      .toEqual({ changed: false, updatedCount: 0, deletedCount: 0 });
  });

  it("counts retained keys and UTF-8 bytes at the exact limit", () => {
    expect(applyEnvironmentPatch({ AA: "x".repeat(4092) }, { BB: "" }).variables.BB).toBe("");
    expect(() => applyEnvironmentPatch({ AA: "x".repeat(4093) }, { BB: "" })).toThrow("4096-byte");
    expect(applyEnvironmentPatch({}, { AA: "é".repeat(2047) }).result.changed).toBe(true);
    expect(() => applyEnvironmentPatch({}, { AA: "é".repeat(2047) + "x" })).toThrow("4096-byte");
  });
});
