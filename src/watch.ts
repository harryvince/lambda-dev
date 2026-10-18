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
  const watchPlan = createWatchPlan(
    loaded.projectRoot,
    loaded.target.watch.include,
    loaded.target.watch.exclude,
  );
  const watcherFactory =
    options.watchFactory ?? ((paths, watchOptions) => chokidar.watch(paths, watchOptions));
  const runner = new SerializedDebouncedRunner(loaded.target.watch.debounceMs, async () => {
    await deployTarget({
      configPath: options.configPath,
      targetName: loaded.targetName,
      logger: options.logger,
      deps: options.deps,
    });
  });

  const watcher = watcherFactory(watchPlan.roots, {
    ignored: (filePath) => watchPlan.isIgnored(filePath),
    ignoreInitial: true,
  });

  watcher.on("all", (_event, filePath) => {
    if (!watchPlan.shouldHandle(filePath)) {
      return;
    }

    logStep(options.logger, loaded.targetName, "watch", `Change detected ${filePath}`);
    runner.schedule().catch((error) => options.logger.error(formatError(error)));
  });

  logStep(
    options.logger,
    loaded.targetName,
    "watch",
    `Watching ${loaded.target.watch.include.join(", ")}`,
  );
  return watcher;
}

export interface WatchPlan {
  roots: string[];
  shouldHandle(filePath: string): boolean;
  isIgnored(filePath: string): boolean;
}

export function createWatchPlan(
  projectRoot: string,
  includes: string[],
  excludes: string[],
): WatchPlan {
  const normalizedRoot = path.resolve(projectRoot);
  const includeMatchers = includes.map((pattern) => createMatcher(pattern));
  const excludeMatchers = excludes.map((pattern) => createMatcher(pattern));
  const roots = Array.from(
    new Set(includes.map((pattern) => path.resolve(normalizedRoot, getWatchRoot(pattern))).sort()),
  );

  return {
    roots: roots.length > 0 ? roots : [normalizedRoot],
    shouldHandle(filePath: string): boolean {
      const relativePath = toRelativeUnixPath(normalizedRoot, filePath);
      return (
        includeMatchers.some((matches) => matches(relativePath)) &&
        !excludeMatchers.some((matches) => matches(relativePath))
      );
    },
    isIgnored(filePath: string): boolean {
      const relativePath = toRelativeUnixPath(normalizedRoot, filePath);
      return excludeMatchers.some((matches) => matches(relativePath));
    },
  };
}

function getWatchRoot(pattern: string): string {
  const unixPattern = toUnixPath(pattern);
  const wildcardIndex = unixPattern.search(/[*[{?]/);
  const stablePrefix = wildcardIndex === -1 ? unixPattern : unixPattern.slice(0, wildcardIndex);
  const directory = stablePrefix.endsWith("/")
    ? stablePrefix.slice(0, -1)
    : path.posix.dirname(stablePrefix);

  if (!directory || directory === ".") {
    return ".";
  }

  return directory;
}

function createMatcher(pattern: string): (relativePath: string) => boolean {
  const normalizedPattern = toUnixPath(pattern).replace(/^\.\/+/, "");
  const regex = globToRegExp(normalizedPattern);
  return (relativePath: string) => regex.test(relativePath);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      const afterNext = pattern[index + 2];
      if (afterNext === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  // The pattern comes from the user's own watch config, every regex metacharacter is escaped above,
  // and it only ever matches local file paths, so it isn't an untrusted-input ReDoS risk.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`${source}$`);
}

function escapeRegExp(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function toRelativeUnixPath(projectRoot: string, filePath: string): string {
  return toUnixPath(path.relative(projectRoot, path.resolve(filePath)));
}

function toUnixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export class SerializedDebouncedRunner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private rerunRequested = false;
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(
    private readonly debounceMs: number,
    private readonly operation: () => Promise<void>,
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
