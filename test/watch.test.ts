import { describe, expect, it, vi } from "vitest";
import { SerializedDebouncedRunner } from "../src/watch.js";

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
        })
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
