import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // End-to-end tests need an emulator; run them with `mise run test:e2e`.
    exclude: ["test/e2e/**"],
    restoreMocks: true,
  },
});
