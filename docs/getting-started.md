# Getting started

## Prerequisites

- **Node.js 20 or later.**
- **An existing Lambda function** using a Node.js runtime, ideally a dedicated development copy.
- **AWS credentials** that the AWS SDK can find: environment variables, `~/.aws/credentials`, SSO, or an instance/container role. You can also name a profile per target. The credentials need the permissions in [IAM permissions](iam-permissions.md).

## Install

Add it to the project that contains your handler:

=== "npm"

    ```bash
    npm install --save-dev aws-lambda-dev
    ```

=== "bun"

    ```bash
    bun add --dev aws-lambda-dev
    ```

=== "pnpm"

    ```bash
    pnpm add --save-dev aws-lambda-dev
    ```

Or run it without installing, using `npx aws-lambda-dev` or `bunx aws-lambda-dev`. The examples below use `npx`.

## 1. Create a config

```bash
npx aws-lambda-dev init
```

This writes a starter `lambda-dev.yml` in the current directory. It won't overwrite an existing file.

Edit it so the `dev` target points at your function and handler:

```yaml title="lambda-dev.yml"
version: 1
defaultTarget: dev
targets:
  dev:
    functionName: my-existing-lambda-dev # (1)!
    region: eu-west-2
    build:
      entry: src/handler.ts # (2)!
      target: node20
      external:
        - "@aws-sdk/*" # (3)!
    watch:
      include:
        - src/**/*.ts
    invoke:
      afterDeploy: true
      payloadFile: events/dev.json # (4)!
```

1. The name (or ARN) of a function that already exists.
2. Your handler file, relative to `lambda-dev.yml`. It's bundled to `index.js`, so set the function's handler to `index.handler` (or `index.<your export>`).
3. The AWS SDK v3 ships with the Node.js Lambda runtimes, so it's usually left out of the bundle.
4. A JSON event to send after each deploy. Remove `invoke` if you don't want automatic invocations.

!!! note "Handler setting"
    The zip contains `index.js` at its root, so the function's **Handler** setting in Lambda must be `index.<export name>`, e.g. `index.handler`. Set this once in the console or your infrastructure code.

## 2. Validate

```bash
npx aws-lambda-dev validate
```

```text
[dev] validation: ok
```

This checks the YAML and the target selection without building or calling AWS.

## 3. Deploy once

```bash
npx aws-lambda-dev deploy --invoke
```

Builds, uploads, and invokes the default target. Pass a target name to pick another one: `npx aws-lambda-dev deploy staging`.

## 4. Watch

```bash
npx aws-lambda-dev watch
```

Every save that matches `watch.include` runs a full build-upload-invoke cycle. Stop it with ++ctrl+c++.

A failed cycle (for example a type error that breaks the build) is logged and watch keeps running; fix the file and save again.

!!! tip
    Add `.lambda-dev/` to your `.gitignore`. It holds the build output for each target.
