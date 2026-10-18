import { describe, expect, it } from "vitest";
import { formatError, previewPayload, redact } from "../src/output.js";
import { LambdaDevError } from "../src/errors.js";

describe("output", () => {
  it("redacts secret-like keys", () => {
    expect(redact({ accessKey: "abc", nested: { password: "secret", ok: "value" } })).toEqual({
      accessKey: "[redacted]",
      nested: { password: "[redacted]", ok: "value" },
    });
  });

  it("redacts inline AWS credential assignments inside strings and arrays", () => {
    expect(
      redact({
        command: "AWS_SECRET_ACCESS_KEY=abc123 node app.js",
        list: ['AWS_SESSION_TOKEN=tok"en', "keep me"],
      }),
    ).toEqual({
      command: "AWS_SECRET_ACCESS_KEY=[redacted] node app.js",
      list: ['AWS_SESSION_TOKEN=[redacted]"en', "keep me"],
    });
  });

  it("shows strings quoted so they can't be confused with other JSON values", () => {
    expect(previewPayload("123")).toBe("'123'");
    expect(previewPayload(123)).toBe("123");
    expect(previewPayload(undefined)).toBe("undefined");
  });

  it("truncates oversized payload previews", () => {
    const preview = previewPayload({ body: "a".repeat(40) }, 20);
    expect(preview).toContain("[truncated");
  });

  it("formats typed errors with category and hint", () => {
    const message = formatError(
      new LambdaDevError("validation", "No target", { hint: "Pick one." }),
    );

    expect(message).toContain("[validation]");
    expect(message).toContain("Hint: Pick one.");
  });
});
