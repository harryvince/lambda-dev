# Troubleshooting

Errors are printed as `[category] message`, usually with a `Hint:` line. The category tells you which stage failed and what has already happened in AWS.

| Category | Stage | Has AWS been changed? |
| --- | --- | --- |
| `validation` | Reading the config or choosing a target | No |
| `filesystem` | Reading the config file | No |
| `build` | esbuild, or copying files | No |
| `aws_snapshot` | Saving the rollback snapshot before the first deploy | No |
| `aws_configuration` | Syncing environment variables, or waiting for an update | Possibly |
| `aws_deploy` | Uploading code | Environment may have been updated |
| `aws_invoke` | Invoking | Code was uploaded |
| `unexpected` | Anything else | Depends |

## `validation`

The YAML is invalid, a key is unknown or misspelled, a value has the wrong type, or the target doesn't exist. The message names each failing key. For a misspelt `entry`:

```text
[validation] Invalid config /path/to/lambda-dev.yml: targets.dev.build.entry: Invalid input: expected string, received undefined; targets.dev.build: Unrecognized key: "entri"
```

Nothing has been sent to AWS.

```bash
npx aws-lambda-dev validate
```

## `filesystem`

The config file couldn't be read. Check the path, or pass `--config`.

## `build`

esbuild failed, or a `build.copy` entry is invalid. The upload and invoke are skipped. In `watch` mode, fix the error and save again.

## `aws_snapshot`

The CLI couldn't save the function's current code and environment before its first deploy, so it stopped without changing anything. Common causes:

- Missing `lambda:GetFunction` permission.
- No access to the KMS key the function's environment is encrypted with.
- The function is a container image, which this tool doesn't deploy.
- The function's current code is over 50 MB zipped, more than `rollback` could upload.

Fix the cause and deploy again, or set `snapshot: false` on the target to deploy without a snapshot. See [Rollback](rollback.md).

## `aws_configuration`

Reading or updating environment variables failed, or the function didn't reach a ready state within 120 seconds. Common causes:

- Missing `lambda:GetFunctionConfiguration` or `lambda:UpdateFunctionConfiguration` permission.
- No access to the KMS key the function's environment is encrypted with.
- The function is mid-update from another tool or deploy.
- **`PreconditionFailedException`:** someone changed the function's configuration between the read and the write. Nothing was overwritten; rerun.
- The variables would exceed Lambda's 4 KB limit.

A previous step may already have completed, so check the function's state in the console before retrying.

## `aws_deploy`

The code upload failed. Usually credentials, region, function name, or a missing `lambda:UpdateFunctionCode` permission. If credentials couldn't be loaded at all, the hint names the `profile` to check; for SSO profiles, run `aws sso login --profile <name>` first. If the target has `environment`, the environment update may already have been applied.

## `aws_invoke`

The upload succeeded but invoking failed, usually a missing `lambda:InvokeFunction` permission. If the function ran and threw an error, that isn't reported here: the invoke summary shows `functionError Unhandled` instead.

## Watch doesn't react to changes

- The file must match a `watch.include` glob and not match `watch.exclude`.
- Globs are relative to the config file's directory.
- Changes to `watch` settings need a restart.

## The function can't find its handler

The zip has `index.js` at its root, so set the function's **Handler** to `index.<export>`, e.g. `index.handler`.
