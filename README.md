# aws-lambda-dev

`aws-lambda-dev` is a local developer CLI for existing AWS Lambda functions. It watches source files, bundles a Node.js Lambda with esbuild, uploads the generated zip to AWS Lambda, and can invoke the function after each successful deploy.

**Documentation: https://harryvince.github.io/lambda-dev/**

## Quick Start

```bash
mise install
mise run install
mise run build
bunx aws-lambda-dev init
```

Edit `lambda-dev.yml` so `functionName`, `region`, and `build.entry` point at an existing non-production Lambda.

```bash
bunx aws-lambda-dev validate
bunx aws-lambda-dev deploy dev --invoke
bunx aws-lambda-dev watch dev
```

The npm package and installed command are both named `aws-lambda-dev`.

## Development

Tool versions and project tasks are managed with mise. Normal development uses Bun rather than npm.

```bash
mise install
mise run install   # also installs the mandatory prek Git hooks
mise run check
```

Every commit must pass the prek hooks (oxfmt, oxlint with anti-slop rules, Trivy, and Semgrep). See [Contributing](https://harryvince.github.io/lambda-dev/contributing/).

Useful tasks:

```bash
mise run typecheck
mise run test
mise run build
mise run clean
```

## Publishing

Publishing tasks are defined in `mise.toml`. They use the npm-compatible package publishing flow, but credentials must come from your local or CI npm auth configuration. Do not commit tokens to this repository.

```bash
mise run pack
mise run version
mise run publish:dry-run
mise run publish
```

Run `mise run version` before publish tasks so release versioning is handled by the configured release workflow, then run `publish:dry-run` before the real publish task.

Pushing a `v*` tag (which `mise run version` does) also triggers `.github/workflows/publish.yml`. It checks the tag matches `package.json`, runs `mise run check`, and publishes with provenance using npm trusted publishing, so no npm token is stored in GitHub. Use either the workflow or the local `publish` task for a release, not both.

## Config

Configs include a link to the [JSON Schema](https://harryvince.github.io/lambda-dev/schema.json), so editors using the YAML language server autocomplete and validate them. See [Editor support](https://harryvince.github.io/lambda-dev/configuration/#editor-support).

```yaml
# yaml-language-server: $schema=https://harryvince.github.io/lambda-dev/schema.json
version: 1
defaultTarget: dev
targets:
  dev:
    functionName: my-existing-lambda-dev
    region: eu-west-2
    profile: default
    build:
      entry: src/handler.ts
      bundle: true
      platform: node
      target: node20
      format: cjs
      sourcemap: true
      external:
        - "@aws-sdk/*"
    watch:
      include:
        - src/**/*.ts
      exclude:
        - dist/**
        - node_modules/**
        - .lambda-dev/**
      debounceMs: 300
    invoke:
      afterDeploy: true
      payloadFile: events/dev.json
```

Do not put AWS access keys, secrets, or production-only payloads in this file. The CLI uses the standard AWS SDK credential chain and supports an optional named `profile`.

## Runtime files and binaries

Add `build.copy` to include files that esbuild cannot bundle, such as native helpers, dependency schemas, templates, or other runtime assets. Each entry has `from` and `to`:

```yaml
build:
  entry: src/handler.ts
  copy:
    - from: assets/native-helper
      to: bin/native-helper
    - from: assets/runtime
      to: runtime
    - from: assets/schemas/**/*.json
      to: schemas
```

Sources resolve relative to the directory containing `lambda-dev.yml`, regardless of the shell's working directory. Destinations are relative to `build.outDir` and the Lambda ZIP root:

- For a single file, `to` is the destination filename (including any parent directories).
- For a directory, its contents are copied recursively into `to`, including hidden files and empty directories.
- For a glob, matched files retain their paths relative to the directory before the first glob segment. For example, `assets/schemas/**/*.json` copies `assets/schemas/nested/event.json` to `schemas/nested/event.json`. Use `*`, `**`, `?`, character classes, or brace patterns such as `*.{json,txt}`; quote YAML patterns starting with `*`. Glob patterns select files and omit dotfiles unless explicitly matched, for example `assets/.*`.
- Use `to: .` to place directory contents or glob matches at the ZIP root. A single file requires a filename.

Copying is optional and defaults to an empty list. Files retain their binary contents and executable permission bits in the output and ZIP. Every build clears obsolete output assets. A missing source or unmatched glob fails the build and skips deployment.

Destinations cannot be absolute, contain `..` path segments, or collide with another copied path or generated `index.js`, `index.js.map`, or `function.zip`. Sources cannot overlap the build output. Symbolic links in copy paths and scanned source trees are rejected, including links that a glob would otherwise skip. Choose a source directory separate from your output directory.

For `jaeger-client` or another dependency, select the runtime files required by your installed package version and set `to` to the location that its runtime code expects. For example, if bundled code looks for `__dirname + "/runtime/schema.json"`, copy that schema to `runtime/schema.json`. Paths in the example above are illustrative. Native binaries must already be compatible with Lambda's Linux environment and configured CPU architecture; copying does not compile or convert them. This uses the existing esbuild workflow and provides CopyPlugin-style copying through YAML.

Asset changes trigger watch rebuilds only when their paths are included in `watch.include`. For example, add `assets/**/*` alongside `src/**/*.ts`; keep build output excluded. Dependencies under `node_modules` also need a corresponding change to `watch.exclude` if you want to watch them.

## YAML anchors and shared configuration

Use anchors (`&name`) and aliases (`*name`) to reuse build options or copy lists across targets. Mapping merge keys (`<<`) let a target override individual values:

```yaml
# yaml-language-server: $schema=https://harryvince.github.io/lambda-dev/schema.json
version: 1
defaultTarget: dev
targets:
  dev:
    functionName: my-lambda-dev
    region: eu-west-2
    build: &sharedBuild
      entry: src/handler.ts
      copy: &sharedCopy
        - from: assets/runtime
          to: runtime
  staging:
    functionName: my-lambda-staging
    region: eu-west-2
    build:
      <<: *sharedBuild
      minify: true
      copy: *sharedCopy
```

Define an anchor before its alias. Explicit values override merged values. For multiple mappings, use `<<: [*first, *second]`; earlier mappings take precedence. Merges are shallow: nested mappings need their own merge, and lists are replaced rather than concatenated. Put anchors inside supported configuration fields as shown above; arbitrary top-level `defaults` keys are rejected. Invalid aliases and merges produce validation errors, and alias expansion is bounded.

## Lambda environment variables

Set `environment` on a target to update runtime variables during `deploy` and `watch`:

```yaml
# yaml-language-server: $schema=https://harryvince.github.io/lambda-dev/schema.json
version: 1
defaultTarget: dev
targets:
  dev:
    functionName: my-lambda-dev
    region: eu-west-2
    environment: &sharedEnvironment
      LOG_LEVEL: debug
      JAEGER_SERVICE_NAME: my-service
      ENABLE_TRACING: "true"
      EMPTY_VALUE: ""
      OLD_FLAG: null
    build: &sharedBuild
      entry: src/handler.ts
  staging:
    functionName: my-lambda-staging
    region: eu-west-2
    environment:
      <<: *sharedEnvironment
      LOG_LEVEL: info
    build: *sharedBuild
```

Strings set or update a variable; `null` explicitly deletes it. Unspecified remote variables are preserved. Removing an entry from YAML stops managing that variable and does not remove it from Lambda. An omitted `environment` field or an empty map (`environment: {}`) disables environment synchronization entirely.

Values must be strings or `null`; quote booleans and numbers such as `"true"` and `"8080"`. Empty strings are supported. Values are literal: `${LOCAL_VALUE}` is sent as that exact text, without reading the local shell or `.env` files. Keys must start with a letter, contain only letters, digits, and underscores, and have at least two characters. Lambda-reserved names such as `AWS_REGION` are rejected; custom `AWS_` names are not rejected solely by prefix. The final environment, including retained existing variables, must fit within Lambda's 4 KB limit. See [AWS environment variable rules](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html).

The CLI builds locally before changing AWS. For a nonempty environment patch, it waits for any in-progress update, reads and merges the current variables, writes only if needed using the configuration revision, waits for that update, uploads code, and waits for code completion before optional invocation. Each update wait has a 120-second limit. It checks for an active function and successful update state before proceeding. Configuration read failures fail closed. A concurrent configuration change fails the revision guard; rerun to obtain a fresh revision instead of overwriting the newer change.

**Configuration and code updates are separate AWS operations.** If the code upload fails, your environment may already be updated. A timeout also means the remote operation might still complete. Inspect Lambda's state and configuration, correct any permissions or values, then retry once stable. To restore previous settings, explicitly supply the desired values or deletions, or run `rollback` to restore the environment and code saved before the first deploy. Environment updates affect the unpublished function configuration, not published immutable versions.

Environment values are omitted from synchronization logs, summaries, and configuration failure diagnostics. Keep secrets out of committed YAML; use your existing secrets-management approach for sensitive data. Invoked application responses and requested Lambda logs retain their existing behavior, so your function should also avoid printing secrets.

Add `lambda-dev.yml` to `watch.include` alongside your source globs if editing YAML should itself trigger deployment. Without that opt-in, changed environment settings are picked up on the next included source-file event. Standalone `validate` and `invoke` do not update the environment. Targets with omitted/empty environment retain the existing code deployment path.

## Commands

```bash
aws-lambda-dev init [--config lambda-dev.yml]
aws-lambda-dev validate [target] [--config lambda-dev.yml]
aws-lambda-dev deploy [target] [--config lambda-dev.yml] [--invoke] [--no-cache]
aws-lambda-dev invoke [target] [--config lambda-dev.yml] [--payload-file event.json]
aws-lambda-dev watch [target] [--config lambda-dev.yml]
aws-lambda-dev rollback [target] [--config lambda-dev.yml]
```

Before the first deploy to a function, the CLI saves its current code and environment to `.lambda-dev/snapshots/`. `rollback` restores them, then deletes the snapshot. A failed snapshot stops the deploy before anything changes; set `snapshot: false` on a target to skip it. The snapshot holds environment values in plain text, so keep `.lambda-dev/` out of version control.

Builds are cached in `.lambda-dev/build-cache/`. When a target's build options, copy list, and every bundled and copied file match an earlier build (by any target), `deploy` reuses that zip instead of rebuilding, so deploying the same code to dev, staging, and prod uploads byte-identical artifacts. Set `build.cache: false` or pass `--no-cache` to always rebuild.

## Minimum IAM Permissions

Use the smallest resource ARN that matches your development Lambda.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode",
        "lambda:InvokeFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionConfiguration"
      ],
      "Resource": "arn:aws:lambda:eu-west-2:123456789012:function:my-existing-lambda-dev"
    }
  ]
}
```

`lambda:GetFunctionConfiguration` and `lambda:UpdateFunctionConfiguration` are needed for nonempty environment patches and their completion waits. `lambda:GetFunction` is needed for the rollback snapshot unless `snapshot: false`, and `rollback` also needs the two configuration permissions. KMS-encrypted environments may also require access to the existing encryption key; the CLI does not modify that key.

## Troubleshooting

- `validation`: fix `lambda-dev.yml` before retrying; AWS is not called when config validation fails.
- `build`: esbuild failed, so upload and invoke are skipped for that cycle.
- `aws_deploy`: credentials, region, IAM, or function name prevented upload. Environment synchronization may already have completed.
- `aws_snapshot`: saving the rollback snapshot failed before any AWS change. Grant `lambda:GetFunction`, or set `snapshot: false`.
- `aws_configuration`: environment read/update or completion checks failed. Inspect the function status, revision, and IAM/KMS access before retrying; code upload/invocation stops at the failed stage.
- `aws_invoke`: deploy may have succeeded, but the test invocation failed.

Watch mode debounces rapid saves and serializes deploys per target. If a file changes while a deploy is active, another cycle is queued after the current one finishes.

## License

[MIT](LICENSE)
