# Environment variables

Add `environment` to a target to set or delete the function's environment variables on every `deploy` and `watch` cycle.

```yaml
targets:
  dev:
    functionName: my-lambda-dev
    region: eu-west-2
    environment:
      LOG_LEVEL: debug
      ENABLE_TRACING: "true"
      PORT: "8080"
      EMPTY_VALUE: ""
      OLD_FLAG: null
    build:
      entry: src/handler.ts
```

## It's a patch, not a replacement

| In YAML | Effect on Lambda |
| --- | --- |
| `KEY: "value"` | Sets or updates `KEY`. |
| `KEY: null` | Deletes `KEY`. |
| Not listed | Left as it is. |

Removing a line from YAML stops managing that variable; it doesn't delete it from Lambda. To delete it, set it to `null` for one deploy.

If `environment` is missing or empty (`environment: {}`), the CLI doesn't touch the function's configuration at all.

## Values

- Values must be strings or `null`. Quote booleans and numbers: `"true"`, `"8080"`.
- Empty strings are allowed.
- Values are sent exactly as written. `${HOME}` is sent as the literal text `${HOME}`; nothing is read from your shell or `.env` files.

## Names

- Must start with a letter, contain only letters, digits, and underscores, and be at least two characters long.
- Names Lambda reserves, such as `AWS_REGION`, `AWS_LAMBDA_FUNCTION_NAME`, or `_HANDLER`, are rejected. Other names starting with `AWS_` are allowed.
- The total size of all variables on the function, including ones you don't manage here, must stay under Lambda's 4 KB limit.

See [Lambda environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html) for AWS's rules.

## Sharing between targets

```yaml
targets:
  dev:
    environment: &sharedEnvironment
      LOG_LEVEL: debug
      SERVICE_NAME: orders
    # ...
  staging:
    environment:
      <<: *sharedEnvironment
      LOG_LEVEL: info
    # ...
```

## What happens during a deploy

Environment changes and code uploads are separate AWS operations. With a non-empty `environment`, a deploy:

1. Builds locally. A build failure stops here, before any AWS call.
2. Waits for any update already in progress on the function.
3. Reads the current variables and merges your changes into them.
4. Writes the configuration only if something changed. The write is tied to the revision it read, so if someone else changed the function in between, it fails instead of overwriting their change. Rerun to pick up the new revision.
5. Waits for the configuration update to finish.
6. Uploads the code and waits for that to finish. The upload is tied to the revision the function had after step 5, so if anything else changed the function in between, such as someone else deploying, it fails instead of mixing their changes with yours.
7. Invokes the function, if requested.

Each wait gives up after 120 seconds.

!!! warning "Not atomic"
    If step 6 fails, the environment change from step 4 has already been applied. A timeout can also mean the change is still being applied. Check the function in the console, fix the cause, and rerun. To undo a single change, set the old value (or `null`) and deploy again. To put back the whole environment and code as they were before your first deploy, use [`rollback`](rollback.md).

Changes apply to the function's unpublished configuration (`$LATEST`), not to published versions.

## Secrets

The CLI never prints environment values: they're left out of logs, summaries, and error messages, including YAML parse errors. Even so, **don't commit secrets in `lambda-dev.yml`**. Use your usual secrets management (for example Secrets Manager or SSM Parameter Store) and read them in the function.

The CLI can't stop your function from logging its own environment, so make sure your code doesn't either.

## Watching the config file

Environment changes are picked up on the next deploy. To deploy as soon as you save `lambda-dev.yml`, add it to `watch.include`:

```yaml
watch:
  include:
    - src/**/*.ts
    - lambda-dev.yml
```

`validate` and `invoke` never sync environment variables.
