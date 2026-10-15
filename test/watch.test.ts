import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWatchPlan, SerializedDebouncedRunner, watchTarget } from "../src/watch.js";
import type { LambdaAdapter } from "../src/aws.js";

describe("SerializedDebouncedRunner", () => {
  it("coalesces rapid changes into one run", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockResolvedValue(undefined);
    const runner = new SerializedDebouncedRunner(300, operation);

    const first = runner.schedule();
    const second = runner.schedule();
    await vi.advanceTimersByTimeAsync(299);
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    expect(operation).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("queues a rerun when scheduled during an active cycle", async () => {
    vi.useFakeTimers();
    const operation = vi.fn();
    let releaseFirstRun!: () => void;
    operation.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        }),
    );
    operation.mockResolvedValueOnce(undefined);
    const runner = new SerializedDebouncedRunner(1, operation);

    const first = runner.schedule();
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(1);
    const second = runner.schedule();
    await vi.advanceTimersByTimeAsync(1);
    releaseFirstRun();
    await Promise.all([first, second]);

    expect(operation).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("watch pattern handling", () => {
  it("matches included source globs and excludes generated output", () => {
    const root = path.resolve("/tmp/project");
    const plan = createWatchPlan(root, ["src/**/*.ts"], [".lambda-dev/**", "node_modules/**"]);

    expect(plan.roots).toEqual([path.join(root, "src")]);
    expect(plan.shouldHandle(path.join(root, "src", "handler.ts"))).toBe(true);
    expect(plan.shouldHandle(path.join(root, "src", "nested", "handler.ts"))).toBe(true);
    expect(plan.shouldHandle(path.join(root, "src", "handler.js"))).toBe(false);
    expect(plan.shouldHandle(path.join(root, ".lambda-dev", "index.js"))).toBe(false);
    expect(plan.isIgnored(path.join(root, ".lambda-dev", "index.js"))).toBe(true);
  });

  it("lets excludes win when a path is also included", () => {
    const root = path.resolve("/tmp/project");
    const plan = createWatchPlan(root, ["src/**/*"], ["src/generated/**"]);

    expect(plan.shouldHandle(path.join(root, "src", "handler.ts"))).toBe(true);
    expect(plan.shouldHandle(path.join(root, "src", "generated", "handler.ts"))).toBe(false);
  });

  it("runs deploy for fake watcher events that match include patterns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aws-lambda-dev-watch-"));
    await writeFile(
      path.join(root, "lambda-dev.yml"),
      `version: 1
defaultTarget: dev
targets:
  dev:
    functionName: dev-function
    region: eu-west-2
    build:
      entry: src/handler.ts
    watch:
      include:
        - src/**/*.ts
      exclude:
        - .lambda-dev/**
      debounceMs: 1
`,
    );

    const watcher = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
    watcher.close = vi.fn().mockResolvedValue(undefined);
    const buildArtifact = vi.fn().mockResolvedValue({
      artifactPath: path.join(root, "function.zip"),
      artifactBytes: new Uint8Array([1]),
      sizeBytes: 1,
      durationMs: 1,
    });
    const lambda: LambdaAdapter = {
      updateEnvironment: vi.fn().mockResolvedValue({ changed: false, updatedCount: 0, deletedCount: 0 }),
      waitForUpdate: vi.fn().mockResolvedValue(undefined),
      updateFunctionCode: vi.fn().mockResolvedValue({ functionName: "dev-function" }),
      invokeFunction: vi.fn(),
    };

    await watchTarget({
      configPath: path.join(root, "lambda-dev.yml"),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      deps: { buildArtifact, lambda },
      watchFactory: () => watcher as never,
    });

    watcher.emit("all", "change", path.join(root, ".lambda-dev", "index.js"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(buildArtifact).not.toHaveBeenCalled();

    watcher.emit("all", "change", path.join(root, "src", "handler.ts"));
    await vi.waitFor(() => expect(buildArtifact).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(lambda.updateFunctionCode).toHaveBeenCalledTimes(1));
    expect(lambda.updateEnvironment).not.toHaveBeenCalled();

    const configPath = path.join(root, "lambda-dev.yml");
    await writeFile(configPath, (await readFile(configPath, "utf8")).replace("    build:", "    environment: { LOG_LEVEL: trace }\n    build:"));
    watcher.emit("all", "change", path.join(root, "src", "handler.ts"));
    await vi.waitFor(() => expect(lambda.updateFunctionCode).toHaveBeenCalledTimes(2));
    expect(lambda.updateEnvironment).toHaveBeenCalledOnce();
    expect(vi.mocked(lambda.updateEnvironment).mock.calls[0][0].target.environment).toEqual({ LOG_LEVEL: "trace" });
    expect(lambda.waitForUpdate).toHaveBeenCalledOnce();
  });
});
