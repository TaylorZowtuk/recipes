# Host on AWS behind the CloudFront Free plan, with FastAPI and React + Vite

We host on the household's existing AWS account (legacy Free Tier, Always Free offers only) in `ca-west-1`, in preference to the all-Cloudflare stack that the hosting research ranked first. Lambda runs real CPython, which removes the Pyodide package limits and the 10 ms CPU budget that Python Workers would impose on scraping and ingredient parsing. It also avoids signing up for a new vendor. The cost is that AWS meters instead of stopping at its limits, so the stack is shaped to stay inside Always Free allowances and is guarded by an alarm and a kill switch (below). The backend is **FastAPI** and the frontend is **React + Vite** with `vite-plugin-pwa`, managed with **Terraform**.

## Shape

- **CloudFront Free plan** (flat rate, $0, no overage charges, WAF included) is the only public entry point. Its cache behaviors route `/api/*` to a Lambda function URL, `/images/*` to S3, and everything else to the PWA bundle in S3. The PWA and API share one origin, so there is no CORS and editor cookies are first-party.
- **Origin Access Control on every origin.** The function URL uses `AWS_IAM` auth and the buckets are private, so traffic can't bypass CloudFront's cache and WAF rate limit to reach a metered service. As a consequence, the PWA's fetch wrapper must send `x-amz-content-sha256` (the body's SHA-256) on POST and PUT.
- **Lambda function URL, not API Gateway.** API Gateway's free allowance was a 12-month offer and has expired for this account. FastAPI runs unchanged through the AWS Lambda Web Adapter. It is deployed as a zip: no ECR, no SnapStart, no provisioned concurrency, no VPC, since each of those is billed.
- **S3** holds images (its storage is offset by the plan's 5 GB S3 Standard credit, but its requests are metered). Recipe data goes in DynamoDB ([source-of-truth ADR](2026-09-27-dynamodb-source-of-truth-and-backups.md)), in provisioned mode with auto scaling off, so excess traffic throttles instead of billing.
- **Secrets** live in SSM Parameter Store Standard (free), not Secrets Manager ($0.40 per secret per month).
- **Terraform** state lives in a private S3 bucket with native S3 locking. Terraform was chosen over CDK because the human reviewing infrastructure changes already reads `terraform plan`. The CloudFront Free plan subscription may have to be a one-time console or CLI step.

## Cost and the spending guard

For about 500 recipes, 2 editors and light reads, everything is within Always Free except **S3 requests**: about ⅓¢ a month, plus about 1.5¢ once for the initial bulk load. A $0 alarm would therefore fire on legitimate spend, so the guard is set at **$1 a month for the whole account**:

- An AWS Budget (actual cost > $1) and a CloudWatch `EstimatedCharges > 1` alarm in us-east-1, both sending to SNS.
- SNS emails the household **and** invokes a kill-switch Lambda that sets every API function's reserved concurrency to 0. The app then becomes read-only (the PWA, images and offline cache still work) until someone re-enables the API by hand.
- The controls that bound spend during the 6–12 hour alarm lag: reserved concurrency of about 3 per API function, a WAF rate-limit rule, DynamoDB throttling, and long-lived content-hashed cache keys. At 3 concurrent 200 ms calls, a flood running for 12 hours stays inside Lambda's free 1M requests. The WAF limit is about 1,000 requests per 5 minutes per IP, set above the phones' 3 s sync poll ([offline cache and sync ADR](2026-10-01-offline-cache-and-sync.md)); change the two together.
- AWS's automatic Free Tier usage emails (at 85% of each limit) stay on.

## Considered options

- **All Cloudflare** (Workers + Python Worker + D1 + R2): truly $0 and its limits stop instead of billing, but Python on Pyodide limits which packages can be used and allows 10 ms of CPU per request.
- **AWS compute with Cloudflare R2 for images:** $0 object storage, at the cost of two vendors and two billing setups.
- **Backend:** Litestar (smaller ecosystem), Powertools for AWS Lambda (ties the code to Lambda) and Flask (untyped, no OpenAPI) were rejected. FastAPI's OpenAPI schema generates the TypeScript client, so the two halves can't drift apart.
- **Frontend:** SvelteKit and Vue were rejected for agent familiarity, and Next.js because its strengths (SSR, RSC, server actions, `next/image`) all need a server, while this app is an offline-first static PWA with a Python backend and `noindex` content.
- **Infrastructure as code:** CDK (TypeScript) and SAM were rejected; see Terraform above.
