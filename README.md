# aws-lambda-dev

`aws-lambda-dev` is a local developer CLI for existing AWS Lambda functions. It watches source files, bundles a Node.js Lambda with esbuild, uploads the generated zip to AWS Lambda, and can invoke the function after each successful deploy.

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
mise run install
mise run check
```

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

## Config

```yaml
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

## Commands

```bash
aws-lambda-dev init [--config lambda-dev.yml]
aws-lambda-dev validate [target] [--config lambda-dev.yml]
aws-lambda-dev deploy [target] [--config lambda-dev.yml] [--invoke]
aws-lambda-dev invoke [target] [--config lambda-dev.yml] [--payload-file event.json]
aws-lambda-dev watch [target] [--config lambda-dev.yml]
```

## Minimum IAM Permissions

Use the smallest resource ARN that matches your development Lambda.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode", "lambda:InvokeFunction"],
      "Resource": "arn:aws:lambda:eu-west-2:123456789012:function:my-existing-lambda-dev"
    }
  ]
}
```

## Troubleshooting

- `validation`: fix `lambda-dev.yml` before retrying; AWS is not called when config validation fails.
- `build`: esbuild failed, so upload and invoke are skipped for that cycle.
- `aws_deploy`: credentials, region, IAM, or function name prevented upload.
- `aws_invoke`: deploy may have succeeded, but the test invocation failed.

Watch mode debounces rapid saves and serializes deploys per target. If a file changes while a deploy is active, another cycle is queued after the current one finishes.
