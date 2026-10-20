# Run in us-west-2, because ca-west-1 has no Lambda function URLs

Both stacks and the bootstrap run in **`us-west-2` (Oregon)**, not `ca-west-1` (Calgary). This replaces the region in the [hosting ADR](2026-09-26-aws-hosting-fastapi-react.md); the rest of that decision stands.

`ca-west-1` doesn't offer Lambda function URLs. The first staging deploy failed creating one, and an admin user's `aws lambda list-function-url-configs` there fails the same way (`AccessDeniedException: Unable to determine service/operation name to be authorized`), so it's the region, not a permission. The hosting shape depends on a function URL: it's the only Always Free HTTP front for Lambda that CloudFront can lock with OAC. API Gateway's HTTP API was rejected because its free allowance is a 12-month offer this account has used up, and CloudFront can't lock it with OAC, so the API would be reachable around CloudFront's cache and WAF.

`us-west-2` is the region with every feature the stacks use (function URLs, arm64 Lambda with the Python runtime, DynamoDB, S3, SSM Standard) that is closest to the household in Calgary, about 1,000 km away. It isn't opt-in. Leaving Canada is acceptable to the household; `ca-central-1` (Montreal) was rejected as about three times as far. The distance only matters for API calls that miss CloudFront's cache: pages and images come from the nearest edge either way. CloudFront, its WAF and the Free plan are global and managed from `us-east-1`, so they don't change.

## Consequences

- The data lives in the US.
- The half-built staging stack and the bootstrap in `ca-west-1` are torn down, and bootstrap is applied fresh in `us-west-2`. Bucket and IAM names don't include the region, so they're reused.
- SES, which [editor sign-in](2026-09-29-editor-sign-in.md) noted as missing from `ca-west-1`, exists in `us-west-2`, but it stays rejected: it's metered.
