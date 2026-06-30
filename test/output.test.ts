import { describe, expect, it } from "vitest";
import { formatError, previewPayload, redact } from "../src/output.js";
import { LambdaDevError } from "../src/errors.js";

describe("output", () => {
  it("redacts secret-like keys", () => {
    expect(redact({ accessKey: "abc", nested: { password: "secret", ok: "value" } })).toEqual({
      accessKey: "[redacted]",
      nested: { password: "[redacted]", ok: "value" }
    });
  });

  it("truncates oversized payload previews", () => {
    const preview = previewPayload({ body: "a".repeat(40) }, 20);
    expect(preview).toContain("[truncated");
  });

  it("formats typed errors with category and hint", () => {
    const message = formatError(new LambdaDevError("validation", "No target", { hint: "Pick one." }));
    expect(message).toContain("[validation]");
    expect(message).toContain("Hint: Pick one.");
  });
});
