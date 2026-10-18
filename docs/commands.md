# Commands

```text
aws-lambda-dev <command> [target] [options]
```

Every command except `init` takes an optional `[target]` and `-c, --config <path>` (default `lambda-dev.yml`).

When no target is given, the CLI uses `defaultTarget` from the config, or the only target if there's just one. Otherwise it fails and lists the available targets.

## `init`

```bash
aws-lambda-dev init [-c lambda-dev.yml]
```

Writes a starter config. Fails if the file already exists.

## `validate`

```bash
aws-lambda-dev validate [target] [-c lambda-dev.yml]
```

Parses the config and resolves the target. Doesn't build or call AWS, so it's safe to run in CI.

## `build`

```bash
aws-lambda-dev build [target] [-c lambda-dev.yml] [--no-cache]
```

Builds the target's zip into `build.outDir` without deploying it. Doesn't call AWS. Use it to check that a build works, to inspect the output, or to fill the [build cache](configuration.md#build-cache) before deploying the same code to several targets.

| Option | Description |
| --- | --- |
| `--no-cache` | Build from scratch even if the build cache has a match. |

## `deploy`

```bash
aws-lambda-dev deploy [target] [-c lambda-dev.yml] [--invoke] [--payload-file <path>] [--payload-json <json>] [--no-cache] [--no-expect] [--check]
```

Runs one cycle: build, sync environment variables (if configured), upload, optionally invoke, and optionally run [checks](checks.md).

| Option | Description |
| --- | --- |
| `--invoke` | Invoke after uploading, even if `invoke.afterDeploy` is `false`. |
| `--payload-file <path>` | JSON file to send when invoking. Relative to the config file's directory. |
| `--payload-json <json>` | Inline JSON to send when invoking. |
| `--no-cache` | Build from scratch even if the [build cache](configuration.md#build-cache) has a match. |
| `--no-expect` | Don't compare the invoke response with [`invoke.expect`](checks.md#checking-every-invoke). |
| `--check` | After uploading (and invoking), run all of the target's [checks](checks.md). Fails before building if the target has none. |

If `invoke.afterDeploy` is `true` in the config, `deploy` always invokes; there's no flag to skip it for a single run.

## `invoke`

```bash
aws-lambda-dev invoke [target] [-c lambda-dev.yml] [--payload-file <path>] [--payload-json <json>] [--no-expect]
```

Invokes the function as it is now, without building or uploading. Environment variables aren't synced. If [`invoke.expect`](checks.md#checking-every-invoke) is set, a response that doesn't match fails the command; `--no-expect` skips that.

## `check`

```bash
aws-lambda-dev check [target] [checks...] [-c lambda-dev.yml]
```

Invokes the function as it is now with each of the target's [checks](checks.md) and compares the responses with what they expect. Runs every check by default, or only the ones named. Every selected check runs; the command then fails if any didn't match. Doesn't build or upload.

## `rollback`

```bash
aws-lambda-dev rollback [target] [-c lambda-dev.yml]
```

Restores the target's function to its snapshot from before the first deploy: the original environment variables and code. Then deletes the snapshot. Fails without changing anything if there's no snapshot. See [Rollback](rollback.md).

## `watch`

```bash
aws-lambda-dev watch [target] [-c lambda-dev.yml]
```

Watches the files in `watch.include` and runs a `deploy` cycle on each change, invoking only if `invoke.afterDeploy` is `true`.

- Changes within `watch.debounceMs` of each other trigger one cycle.
- Only one cycle runs at a time. A change during a cycle queues exactly one more cycle after it.
- The config file is re-read at the start of every cycle, so changes to build, environment, and invoke settings apply on the next save. Changes to `watch` settings need a restart.
- A failed cycle is logged and watching continues.

To deploy when `lambda-dev.yml` itself changes, add it to `watch.include`.

## Payloads

When invoking, the payload is chosen in this order. The first one that's set wins:

1. `--payload-json`
2. `invoke.payloadJson` in the config
3. `--payload-file`
4. `invoke.payloadFile` in the config

With none set, the function is invoked with no payload. Note that a configured `payloadJson` takes priority over `--payload-file`.

Payloads must be valid JSON and are always sent as JSON. A string payload is sent as a JSON string (`"hello"`), not as raw text, so to send an object write it as an object rather than as a string containing JSON.

## Output

Each line is prefixed with the target and the stage: `[dev] build: ...`. After an invocation the CLI prints the status code, any `FunctionError`, the executed version, and a preview of the response payload (up to 500 characters). String values are shown in quotes, so `'123'` and `123` can be told apart. Payload previews redact values under keys that look like secrets, such as `password`, `apiKey`, or `secretAccessKey`.

Errors print as `[category] message`, often followed by a `Hint:` line. The process exits with code `1`. See [Troubleshooting](troubleshooting.md) for each category.
