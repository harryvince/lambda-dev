import { describe, expect, it } from "vitest";
import { confirmInTerminal } from "../src/confirm.js";

describe("confirmInTerminal", () => {
  it("can't ask without a terminal", async () => {
    const original = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await expect(confirmInTerminal("Deploy?")).resolves.toBeUndefined();
    } finally {
      process.stdin.isTTY = original;
    }
  });
});
