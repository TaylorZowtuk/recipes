# Modules

Terraform modules shared by [`stacks/prod`](../stacks/prod), [`stacks/staging`](../stacks/staging) and [`bootstrap`](../bootstrap), one directory each.

| Module | What it makes |
| --- | --- |
| `stack` | One whole stack, from `stack-access`, `store`, `api` and `site`. The stacks call only this (and staging also `dev-user`). |
| `stack-access` | No resources: a stack's resource names, its permissions boundary and deploy role ARNs, and the IAM policy that reaches its data. |
| `store` | The DynamoDB table (provisioned, `PK`/`SK`), the images bucket and the sign-in secrets in SSM Parameter Store. |
| `api` | The API Lambda (arm64, Lambda Web Adapter layer), its AWS_IAM function URL, execution role and log group. |
| `site` | The CloudFront distribution, its OACs, the empty WAF web ACL (in us-east-1), the PWA bucket, the SPA-routing CloudFront Function, the Lambda permissions for CloudFront and both buckets' policies. |
| `private-bucket` | An S3 bucket with public access blocked, SSE-S3 and optional versioning. |
| `dev-user` | Staging's dev IAM user, with access to staging's data only. |
| `github-deploy-role` | A stack's GitHub Actions OIDC deploy role and permissions boundary. Called from `bootstrap`, so a deploy can't widen its own permissions. |
