# Modules

Terraform modules shared by [`stacks/prod`](../stacks/prod), [`stacks/staging`](../stacks/staging) and [`bootstrap`](../bootstrap), one directory each.

| Module | What it makes |
| --- | --- |
| `stack` | One whole stack, from `stack-access`, `store`, `api` and `site`. The stacks call only this (and staging also `dev-user`). |
| `stack-access` | No resources: a stack's resource names (OACs included), its permissions boundary and deploy role ARNs, where bootstrap's state lives, and the IAM policy that reaches its data. |
| `store` | The DynamoDB table (provisioned, `PK`/`SK`), the images bucket and the sign-in secrets in SSM Parameter Store. |
| `api` | The API Lambda (arm64, Lambda Web Adapter layer), its AWS_IAM function URL, execution role and log group. |
| `site` | The CloudFront distribution (on bootstrap's OACs), the empty WAF web ACL (in us-east-1), the PWA bucket, the SPA-routing and `noindex` CloudFront Functions, the Lambda permissions for CloudFront and both buckets' policies. |
| `origin-access` | A stack's three CloudFront OACs (api, pwa, images). Called from `bootstrap`, so the deploy roles need no OAC write access; each stack reads the IDs from bootstrap's state. |
| `private-bucket` | An S3 bucket with public access blocked, SSE-S3 and optional versioning. |
| `dev-user` | Staging's dev IAM user, with access to staging's data only. |
| `spend-alarm` | The account's $1-a-month budget and billing alarm (in us-east-1) and the SNS topic they send to. Called from `bootstrap`. |
| `github-deploy-role` | A stack's GitHub Actions OIDC deploy role and permissions boundary. Called from `bootstrap`, so a deploy can't widen its own permissions. |
