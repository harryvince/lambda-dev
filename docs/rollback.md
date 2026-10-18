# Rollback

`rollback` puts a function back exactly as it was before you first deployed to it with aws-lambda-dev: the original code and the original environment variables. Use it when you're done with a shared development function and want to hand it back.

```bash
npx aws-lambda-dev rollback
```

```text
[dev] rollback: Restoring my-existing-lambda-dev to its snapshot from 2026-10-18T13:02:11.000Z
[dev] rollback: Restored the environment (1 set, 2 deleted)
[dev] rollback: Uploading the original code
[dev] rollback: Restored. The snapshot was deleted; the next deploy will take a new one.
```

## Snapshots

Lambda doesn't keep previous code for an unpublished function, so the CLI saves a copy before it overwrites anything. On the first `deploy` or `watch` cycle for a function, after the build and before any change in AWS, it:

1. reads the function with `GetFunction`;
2. downloads its current code zip and checks it against Lambda's checksum;
3. saves the zip and the full environment to `.lambda-dev/snapshots/<region>/<function>/`.

Later deploys see the snapshot and don't take another, so it always holds the function as it was **before** the CLI first touched it. If saving the snapshot fails, the deploy stops before anything in AWS is changed.

Snapshots are keyed by function and region, not by target, so targets that point at the same function share one.

!!! warning "Snapshots contain your environment variables"
    The snapshot stores the function's environment variable values in plain text, readable only by your user. Keep `.lambda-dev/` out of version control.

## What rollback does

1. Reads the snapshot and checks the saved code against its checksum.
2. Sets the environment to exactly the saved variables: changed values are restored, variables added since are deleted. This uses the same revision guard as [environment sync](environment-variables.md).
3. Uploads the saved code and waits for the update to finish.
4. Deletes the snapshot, so the next deploy saves the function's state afresh.

If any step fails, the snapshot is kept and you can run `rollback` again. Stop `watch` first, or the next save will deploy over the restored code.

Rollback restores code and environment variables only. The CLI doesn't change anything else about a function, such as its handler, runtime, memory, or layers.

!!! note "Changes made by others"
    Rollback restores the snapshot regardless of what's deployed now. If someone else deployed to the function after your first deploy, rollback overwrites their change too.

## Turning snapshots off

Set `snapshot: false` on a target to deploy without taking a snapshot. `rollback` then has nothing to restore. You might need this when:

- the credentials you deploy with can't be given `lambda:GetFunction`;
- the function's current code is over 50 MB zipped, which is more than rollback can upload directly;
- the function is a scratch copy you never need to restore.

```yaml
targets:
  dev:
    functionName: my-scratch-lambda
    region: eu-west-2
    snapshot: false
    build:
      entry: src/handler.ts
```

A `build.outDir` that contains `.lambda-dev/snapshots` is rejected while snapshots are on, because every build deletes its output directory.
