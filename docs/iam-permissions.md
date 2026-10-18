# IAM permissions

The credentials you run the CLI with need these actions on the target function. Scope the resource to the exact function ARN.

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

| Action | Needed for |
| --- | --- |
| `lambda:UpdateFunctionCode` | Every `deploy` and `watch` cycle. |
| `lambda:InvokeFunction` | `invoke`, `deploy --invoke`, and `invoke.afterDeploy`. |
| `lambda:GetFunction` | The [rollback snapshot](rollback.md) before the first deploy to a function. Not needed with `snapshot: false`. |
| `lambda:GetFunctionConfiguration` | Targets with a non-empty `environment`, and `rollback`. |
| `lambda:UpdateFunctionConfiguration` | Targets with a non-empty `environment`, and `rollback`. |

Targets without `environment` and with `snapshot: false` only need the first two. `GetFunction` also returns a temporary link to download the code; no S3 permissions are needed for it.

If the function's environment is encrypted with a customer-managed KMS key, you may also need access to that key. The CLI never changes the key.

These are the permissions of **the person or role running the CLI**. The function's own execution role is unchanged.
