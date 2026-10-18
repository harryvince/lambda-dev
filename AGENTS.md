# AGENTS.md

`aws-lambda-dev` is a published npm CLI for iterating on an **existing** AWS Lambda function from a local machine. It reads `lambda-dev.yml`, bundles a Node.js handler with esbuild into a zip, optionally patches the function's environment variables, uploads the code with `UpdateFunctionCode`, and optionally invokes the function. `watch` repeats that loop on file changes. It never creates or deletes Lambda functions or other AWS resources.

## Commands

Tooling is pinned in `mise.toml` (Node, Bun, uv, prek). Use Bun, not npm, for local work.

```bash
mise install          # install toolchain
mise run install      # bun install + prek install (Git hooks)
mise run fix          # oxlint --fix + oxfmt until stable
mise run check        # format check + lint + typecheck + test + build — run before finishing any change
mise run test         # vitest run
mise run typecheck    # tsc over src, test, and scripts
mise run scan         # Trivy dependency scan + Semgrep code scan
prek run --all-files  # every Git hook
```

**The prek Git hooks are mandatory.** Every commit must pass `fix`, `lint`, `scan-deps`, and `scan-code` (see `.pre-commit-config.yaml`). Never use `git commit --no-verify`. If a hook fails, fix the cause; don't weaken the hook, the lint config, or a rule.

Releases go through `mise run version` (standard-version: bumps `package.json`, writes `CHANGELOG.md`, tags and pushes, then `mise run release` creates the GitHub release from that changelog section); the pushed `v*` tag triggers `.github/workflows/publish.yml`, which publishes to npm. Don't run these, or edit `CHANGELOG.md` or the package version by hand, unless asked.

## Layout

| File                      | Responsibility                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`              | commander entrypoint (`dist/cli.js` is the `bin`). Commands: `init`, `validate`, `deploy`, `invoke`, `rollback`, `watch`. Thin; delegates to `core`/`watch`.                              |
| `src/core.ts`             | Use cases: `deployTarget` (build → snapshot → env sync → upload → wait → invoke), `rollbackTarget`, `invokeTarget`, `validateTarget`, payload resolution. Takes injectable `RuntimeDeps`. |
| `src/snapshot.ts`         | Rollback snapshots in `.lambda-dev/snapshots/<region>/<function>/`: original code zip plus environment, checksum-verified on read.                                                        |
| `src/config.ts`           | YAML loading (anchors/merge keys on, alias count capped) and the zod schema. `loadTarget` picks the target and defaults `build.outDir` to `.lambda-dev/<target>`.                         |
| `src/build.ts`            | esbuild bundle to `index.js`, then zip with the sourcemap and copied assets into `function.zip`.                                                                                          |
| `src/copy.ts`             | Resolves and validates `build.copy` entries (files, directories, globs) into a manifest **before** the out dir is cleared.                                                                |
| `src/glob.ts`             | Shared glob helpers (`splitGlob`, `toUnixPath`); matching itself uses Node's `fs.glob` and `path.matchesGlob`.                                                                            |
| `src/aws.ts`              | `LambdaAdapter` interface and `AwsLambdaAdapter` (AWS SDK v3). Handles env read-merge-write with `RevisionId`, update waiters, upload, invoke.                                            |
| `src/environment.ts`      | Reserved env var names, patch merge logic, 4 KB limit check.                                                                                                                              |
| `src/watch.ts`            | chokidar watcher, include/exclude glob matching, `SerializedDebouncedRunner` (debounced, one deploy at a time, coalesces changes made mid-deploy).                                        |
| `src/errors.ts`           | `LambdaDevError` with a `category` and optional `hint`.                                                                                                                                   |
| `src/json.ts`             | `JsonValue` type and `parseJson`, used for invoke payloads.                                                                                                                               |
| `src/output.ts`           | Logger and `[target] stage: message` formatting.                                                                                                                                          |
| `src/scaffold.ts`         | Writes the starter config for `init`.                                                                                                                                                     |
| `src/index.ts`            | Library re-exports.                                                                                                                                                                       |
| `examples/lambda-dev.yml` | Example config shipped in the package.                                                                                                                                                    |
| `tools/oxlint/anti-slop/` | Vendored anti-slop oxlint rules (owned here; provenance in `UPSTREAM.md`).                                                                                                                |

Tests live in `test/<module>.test.ts`, named after the source module they cover.

User documentation is a [Zensical](https://zensical.org) site: Markdown pages in `docs/`, navigation and theme in `zensical.toml`. Preview with `mise run docs:serve`; `mise run docs:build` builds with `--strict`, so broken links fail. `.github/workflows/docs.yml` deploys it to GitHub Pages on pushes to `main`.

## Conventions

- Lint is oxlint with the vendored anti-slop rules (`tools/oxlint/anti-slop/`, owned by this repo; see `UPSTREAM.md`). Parse external data at its boundary with zod or `parseJson` (`src/json.ts`) instead of `unknown` plus `typeof`. Only error-handling parameters may be `unknown`, and they're named `cause`. Every type assertion needs a `// SAFETY:` comment stating the invariant. Don't silence rules or add casts to pass lint.
- ESM with `NodeNext` resolution: relative imports in `src/` must use the `.js` extension.
- Strict TypeScript. Dependencies are pinned to exact versions; keep it that way.
- Errors that reach the user must be `LambdaDevError` with one of the existing categories (`validation`, `build`, `aws_snapshot`, `aws_deploy`, `aws_configuration`, `aws_invoke`, `filesystem`, `unexpected`). Wrap unknown errors with `toLambdaDevError`. The README troubleshooting section is keyed by these categories.
- Config schemas are `.strict()`: new config keys need a schema change with a `.meta({ description })`, a regenerated `docs/schema.json` (`mise run schema`; a test enforces it), docs in `docs/configuration.md`, and usually an update to `examples/lambda-dev.yml` and `src/scaffold.ts`.
- Config-relative paths (entry, copy sources, payload files, watch globs) resolve against the directory containing `lambda-dev.yml`, not the CWD.
- Tests must not call AWS. Inject a fake `LambdaAdapter` and/or `buildArtifact` through `deps`, and a fake `watchFactory` for watch tests. Use temp directories (`mkdtemp`) for filesystem fixtures.

## Behaviour to preserve

- **Ordering:** load and validate config, then build locally, then change AWS. Validation or build failures must never reach AWS.
- **Environment sync** is a patch, not a replacement. A string sets a variable, `null` deletes it, and unlisted remote variables are kept. A missing or empty `environment` skips configuration calls entirely, so code-only targets need only `UpdateFunctionCode`/`InvokeFunction` (plus `GetFunction` for the snapshot) IAM permissions.
- **Rollback snapshot:** before the first remote change to a function (after the build), save its code and full environment unless `snapshot: false`; a failed snapshot stops the deploy. Never re-snapshot over an existing one: it must hold the state from before the CLI touched the function. Snapshot files are `0600`. `rollback` restores the exact environment, uploads the code, waits, and only then deletes the snapshot.
- Configuration writes use the read `RevisionId` and are never retried blindly on conflict. Waits are bounded to 120 s.
- **Never log environment values.** That covers sync logs, error messages, YAML parse errors (which can echo source lines), and AWS waiter errors (which can embed the full function configuration). Existing code drops these details on purpose.
- Copy safety: reject absolute or `..` destinations, collisions with `index.js`, `index.js.map` and `function.zip`, sources that overlap the out dir, and any symlinks. Preserve file modes in the output and the zip.
- If you change user-facing behaviour, update `docs/` (and `README.md` where it overlaps) to match.
