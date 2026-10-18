# Checks

A check invokes the function with a known event and compares the response with what you expect. Use checks to confirm a deploy works before moving on: a health check, a request that should be rejected, or any smoke test that fits in one invocation.

```yaml title="lambda-dev.yml"
targets:
  prod:
    functionName: orders-prod
    region: eu-west-2
    build:
      entry: src/handler.ts
    checks:
      health:
        payloadJson: { rawPath: /health }
        expect:
          payload: { statusCode: 200 }
      rejects-bad-order:
        payloadFile: events/bad-order.json
        expect:
          payload:
            statusCode: 400
```

Run them on their own with [`check`](commands.md#check), or right after an upload with `deploy --check`:

```bash
npx aws-lambda-dev check prod
npx aws-lambda-dev deploy prod --check
```

```text
[prod] check: health passed (status 200, payload { statusCode: 200, body: '{"ok":true}' })
[prod] check: rejects-bad-order failed: payload.statusCode: expected 400, received 500
[aws_invoke] 1 of 2 checks failed for orders-prod: rejects-bad-order
```

Every selected check runs, even after one fails, and then the command exits with code `1` if any failed. That makes `deploy --check` usable as a deployment gate in CI.

## Automatic rollback

When checks fail after `deploy --check`, the deploy puts the function back as it was **just before that deploy** and then fails:

```text
[prod] rollback: Saving the current code and environment, to restore if checks fail
[prod] deploy: Uploaded orders-prod version $LATEST
[prod] check: health failed: payload.statusCode: expected 200, received 500
[prod] rollback: Checks failed; restoring the code from before this deploy
[prod] rollback: Restored the function to how it was before this deploy
[aws_invoke] 1 of 1 checks failed for orders-prod: health
```

- Before changing anything, the deploy reads the function's current code and environment with `GetFunction` and keeps them in memory. On a function's first deploy it reuses the [rollback snapshot](rollback.md) instead of reading it twice. If that read fails, the deploy stops before anything changes.
- After a failure, it uploads the previous code, and restores the previous environment only if this deploy changed it.
- Only a response that doesn't match rolls back. If invoking fails (for example, a missing permission), the new code stays.
- A failed `invoke.expect` after a deploy rolls back the same way. `watch` never rolls back.
- If the rollback itself fails, the error says so, and the new code may still be live.

This is different from the [`rollback`](rollback.md) command, which goes back to how the function was before your **first** deploy.

To keep the new code deployed when checks fail, pass `--no-rollback`, or set `rollbackOnFailure: false` on the target.

`check` doesn't build or upload, so it can also verify a function deployed some other way. Pass names to run only some checks: `check prod health`.

## Writing expectations

Each check has an event (`payloadJson` or `payloadFile`, as for [`invoke`](configuration.md#invoke)) and an `expect` block:

| Key | Default | Description |
| --- | --- | --- |
| `payload` | none | The expected response. See below. |
| `exact` | `false` | Fail on keys in the response that `payload` doesn't list. |
| `functionError` | `false` | Whether the function should fail with an unhandled error. By default, any `FunctionError` fails the check. |
| `statusCode` | none | Lambda's own invoke status code, normally `200`. This isn't the `statusCode` your handler returns; put that in `payload`. |

`payload` is compared like this:

- **Objects** match if every key you list matches. Keys you don't list are ignored, unless `exact` is `true`. This applies at every level, so `{ statusCode: 200 }` matches a full API Gateway response.
- **Arrays** must have the same length, and each element must match.
- **Everything else** (strings, numbers, booleans, `null`) must be equal. A response that isn't JSON is compared as a string.

Mismatches name the location and both values, like `payload.items[1].id: expected 'a', received 'b'`. Values under keys that look like secrets, such as `apiKey` or `password`, aren't printed.

!!! note "Bodies are strings"
    API Gateway responses carry `body` as a JSON **string**, so `body: { ok: true }` won't match. Either match the exact string, `body: '{"ok":true}'`, or check only `statusCode`.

## Checking every invoke

To check the response of the target's normal invoke, add `expect` under [`invoke`](configuration.md#invoke). It applies to `invoke`, to `deploy --invoke`, and to the invoke after each `deploy` and `watch` cycle when `invoke.afterDeploy` is on:

```yaml
    invoke:
      afterDeploy: true
      payloadFile: events/dev.json
      expect:
        payload: { statusCode: 200 }
```

A mismatch fails the command. After `deploy`, it also [rolls back](#automatic-rollback) the deploy; in `watch`, the error is logged and watching continues. `invoke.expect` applies whatever payload is sent, including one from `--payload-json`, so pass `--no-expect` to `invoke` or `deploy` when you send an event that should get a different response.
