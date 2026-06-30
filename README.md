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
mise run publish:dry-run
mise run publish
```

Run `publish:dry-run` before the real publish task.

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
