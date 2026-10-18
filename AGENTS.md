# AGENTS.md

`aws-lambda-dev` is a published npm CLI for iterating on an **existing** AWS Lambda function from a local machine. It reads `lambda-dev.yml`, bundles a Node.js handler with esbuild into a zip, optionally patches the function's environment variables, uploads the code with `UpdateFunctionCode`, and optionally invokes the function. `watch` repeats that loop on file changes. It never creates or deletes Lambda functions or other AWS resources.

## Commands

Tooling is pinned in `mise.toml` (Node, Bun). Use Bun, not npm, for local work.

```bash
mise install          # install toolchain
mise run install      # bun install
mise run check        # typecheck + test + build — run before finishing any change
mise run test         # vitest run
mise run typecheck    # tsc --noEmit
```

Releases go through `mise run version` (standard-version: bumps `package.json`, writes `CHANGELOG.md`, tags and pushes); the pushed `v*` tag triggers `.github/workflows/publish.yml`, which publishes to npm. Don't run these, or edit `CHANGELOG.md` or the package version by hand, unless asked.

## Layout

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | commander entrypoint (`dist/cli.js` is the `bin`). Commands: `init`, `validate`, `deploy`, `invoke`, `watch`. Thin; delegates to `core`/`watch`. |
| `src/core.ts` | Use cases: `deployTarget` (build → env sync → upload → wait → invoke), `invokeTarget`, `validateTarget`, payload resolution. Takes injectable `RuntimeDeps`. |
| `src/config.ts` | YAML loading (anchors/merge keys on, alias count capped) and the zod schema. `loadTarget` picks the target and defaults `build.outDir` to `.lambda-dev/<target>`. |
| `src/build.ts` | esbuild bundle to `index.js`, then zip with the sourcemap and copied assets into `function.zip`. |
| `src/copy.ts` | Resolves and validates `build.copy` entries (files, directories, globs) into a manifest **before** the out dir is cleared. |
| `src/aws.ts` | `LambdaAdapter` interface and `AwsLambdaAdapter` (AWS SDK v3). Handles env read-merge-write with `RevisionId`, update waiters, upload, invoke. |
| `src/environment.ts` | Reserved env var names, patch merge logic, 4 KB limit check. |
| `src/watch.ts` | chokidar watcher, include/exclude glob matching, `SerializedDebouncedRunner` (debounced, one deploy at a time, coalesces changes made mid-deploy). |
| `src/errors.ts` | `LambdaDevError` with a `category` and optional `hint`. |
| `src/output.ts` | Logger and `[target] stage: message` formatting. |
| `src/scaffold.ts` | Writes the starter config for `init`. |
| `src/index.ts` | Library re-exports. |
| `examples/lambda-dev.yml` | Example config shipped in the package. |

Tests live in `test/<module>.test.ts`, named after the source module they cover.

## Conventions

- ESM with `NodeNext` resolution: relative imports in `src/` must use the `.js` extension.
- Strict TypeScript. Dependencies are pinned to exact versions; keep it that way.
- Errors that reach the user must be `LambdaDevError` with one of the existing categories (`validation`, `build`, `aws_deploy`, `aws_configuration`, `aws_invoke`, `filesystem`, `unexpected`). Wrap unknown errors with `toLambdaDevError`. The README troubleshooting section is keyed by these categories.
- Config schemas are `.strict()`: new config keys need a schema change, a README section, and usually an update to `examples/lambda-dev.yml` and `src/scaffold.ts`.
- Config-relative paths (entry, copy sources, payload files, watch globs) resolve against the directory containing `lambda-dev.yml`, not the CWD.
- Tests must not call AWS. Inject a fake `LambdaAdapter` and/or `buildArtifact` through `deps`, and a fake `watchFactory` for watch tests. Use temp directories (`mkdtemp`) for filesystem fixtures.

## Behaviour to preserve

- **Ordering:** load and validate config, then build locally, then change AWS. Validation or build failures must never reach AWS.
- **Environment sync** is a patch, not a replacement. A string sets a variable, `null` deletes it, and unlisted remote variables are kept. A missing or empty `environment` skips configuration calls entirely, so code-only targets need only `UpdateFunctionCode`/`InvokeFunction` IAM permissions.
- Configuration writes use the read `RevisionId` and are never retried blindly on conflict. Waits are bounded to 120 s.
- **Never log environment values.** That covers sync logs, error messages, YAML parse errors (which can echo source lines), and AWS waiter errors (which can embed the full function configuration). Existing code drops these details on purpose.
- Copy safety: reject absolute or `..` destinations, collisions with `index.js`, `index.js.map` and `function.zip`, sources that overlap the out dir, and any symlinks. Preserve file modes in the output and the zip.
- If you change user-facing behaviour, update `README.md` to match.
