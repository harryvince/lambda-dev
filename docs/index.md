# aws-lambda-dev

`aws-lambda-dev` is a CLI for iterating on an **existing** AWS Lambda function from your machine. Point it at a Node.js handler and a function name, and it rebuilds, uploads, and optionally invokes the function every time you save.

```bash
npx aws-lambda-dev watch dev
```

```text
[dev] watch: Watching src/**/*.ts
[dev] watch: Change detected /home/me/orders/src/handler.ts
[dev] build: Building src/handler.ts
[dev] build: Created /home/me/orders/.lambda-dev/dev/function.zip (48211 bytes, 112 ms)
[dev] deploy: Uploading to my-existing-lambda-dev
[dev] deploy: Uploaded my-existing-lambda-dev version $LATEST
[dev] invoke: Payload { path: '/health' }
[dev] invoke: status 200, version $LATEST, logs available, payload { ok: true }
```

## What it does

Each deploy cycle runs the same steps, in order:

1. **Load and validate** `lambda-dev.yml`. Invalid config stops here, before anything touches AWS.
2. **Build** the handler with esbuild into `index.js`, then zip it with its sourcemap and any [extra files](copying-files.md) you list.
3. **Sync environment variables**, if the target defines any. Only the variables you list are changed; everything else on the function is left alone. See [Environment variables](environment-variables.md).
4. **Upload** the zip with `UpdateFunctionCode`.
5. **Invoke** the function with a test payload, if requested.

`watch` repeats that cycle on file changes, debouncing rapid saves and never running two deploys for the same target at once.

## What it doesn't do

- It doesn't create, delete, or reconfigure Lambda functions (other than environment variables you opt into). Create the function with your usual tooling first.
- It doesn't run your function locally. Code runs in real Lambda, with its real IAM role, VPC, and layers.
- It doesn't publish versions or move aliases. Uploads update `$LATEST`.

!!! warning "Use it on development functions"
    Every save replaces the function's code. Point it at a function you own for development, never at production.

## Next steps

- [Getting started](getting-started.md): install, create a config, and deploy for the first time.
- [Configuration](configuration.md): every option in `lambda-dev.yml`.
- [Commands](commands.md): CLI reference.
