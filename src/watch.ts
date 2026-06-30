import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { deployTarget, type RuntimeDeps } from "./core.js";
import { loadTarget } from "./config.js";
import { formatError, logStep, type Logger } from "./output.js";

type WatchFactoryOptions = Parameters<typeof chokidar.watch>[1];

export interface WatchOptions {
  configPath?: string;
  targetName?: string;
  logger: Logger;
  deps?: Partial<RuntimeDeps>;
  watchFactory?: (paths: string[], options: WatchFactoryOptions) => Pick<FSWatcher, "on" | "close">;
}

export async function watchTarget(options: WatchOptions): Promise<Pick<FSWatcher, "on" | "close">> {
  const loaded = await loadTarget(options.configPath, options.targetName);
  const include = loaded.target.watch.include.map((pattern) => path.resolve(loaded.projectRoot, pattern));
  const watcherFactory = options.watchFactory ?? ((paths, watchOptions) => chokidar.watch(paths, watchOptions));
  const runner = new SerializedDebouncedRunner(loaded.target.watch.debounceMs, async () => {
    await deployTarget({
      configPath: options.configPath,
      targetName: loaded.targetName,
      logger: options.logger,
      deps: options.deps
    });
  });

  const watcher = watcherFactory(include, {
    ignored: loaded.target.watch.exclude.map((pattern) => path.resolve(loaded.projectRoot, pattern)),
    ignoreInitial: true
  });

  watcher.on("all", (_event, filePath) => {
    logStep(options.logger, loaded.targetName, "watch", `Change detected ${filePath}`);
    runner.schedule().catch((error) => options.logger.error(formatError(error)));
  });

  logStep(options.logger, loaded.targetName, "watch", `Watching ${loaded.target.watch.include.join(", ")}`);
  return watcher;
}

export class SerializedDebouncedRunner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private rerunRequested = false;
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(
    private readonly debounceMs: number,
    private readonly operation: () => Promise<void>
  ) {}

  async schedule(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.run().catch(() => {
          // Waiters are rejected in run(); keep timer callbacks from creating unhandled rejections.
        });
      }, this.debounceMs);
    });
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    this.running = true;
    try {
      do {
        this.rerunRequested = false;
        await this.operation();
      } while (this.rerunRequested);
      this.resolveWaiters();
    } catch (error) {
      this.rejectWaiters(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private resolveWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private rejectWaiters(error: unknown): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}
