# Research: AWS and Azure free tiers compared with the hosting shortlist

Question (from the ticket "Research: AWS and Azure free tiers compared with the hosting shortlist"): how do **AWS** (the household already has an account) and **Azure** compare with the shortlist in "Research: free hosting for a Python backend, a TypeScript PWA and image storage"? That shortlist is: all-Cloudflare (recommended), then Vercel Hobby for the Python API, an Oracle Always Free VM, or Render.

The app needs $0 recurring hosting for a Python backend (API, editor sign-in, saving edits), a TypeScript PWA, and storage for 100–500+ recipe images. **Recipe data will be stored alongside the images in whichever image store is chosen**, so object storage is judged as the home of the collection, not only of the images.

**Added constraint from the human:** a card on file is acceptable, but any service that *could* bill must have a spending alarm that fires on anything above $0. Each such mechanism is documented below with how fast it fires and whether it can stop the service or can only notify.

Every limit below was read from the provider's own pricing or docs page on **2026-09-25** unless another date is given. Free tiers change often, so re-check the linked page before relying on a number.

---

## Short answer

**Ranking against the existing shortlist** (1 = best fit for $0 recurring):

| Rank | Option | Status |
|---|---|---|
| 1 | **All Cloudflare** (Workers static PWA + Python Worker + D1 + R2) | Unchanged. Still the recommendation. |
| 2 | Cloudflare PWA + R2, **Python API on Vercel Hobby** | Unchanged. This is the fallback if FastAPI does not fit Pyodide or the 10 ms CPU limit. |
| 3 | **AWS (new):** Python API on **Lambda + function URL**, data in **DynamoDB** (always-free), PWA on Cloudflare or on **CloudFront's flat-rate Free plan** | A credible third option, and the best one if Vercel's non-commercial clause or its 30-day lockout becomes a problem. It runs real CPython 3.12–3.14 in an account the household already has. Its weak points: usage past the free allowance is **metered with no hard cap**, and alarms lag by hours. |
| 4 | Oracle Always Free VM | Unchanged. |
| 5 | **Azure (new):** Static Web Apps Free + managed Functions (Python) + Cosmos DB free tier | Static Web Apps Free is a good $0 PWA host: bandwidth is hard-capped and editor sign-in is built in. But managed Functions only offer **Python ≤3.11** on the Consumption plan, and Linux Consumption **retires on 2028-09-30**. Blob Storage is free for **12 months only**. After the 30-day trial, the subscription must be pay-as-you-go, which has **no spending limit**. |
| 6 | Render free | Unchanged. |

**Does either change the recommendation?** No. All-Cloudflare stays first, and Vercel stays the fallback for the API.

AWS is the better of the two newcomers:
- The Lambda and DynamoDB always-free allowances are permanent and far exceed a household's needs.
- Real CPython removes the Pyodide risk.
- The existing account means no new signup.

AWS still does not beat Cloudflare, for three reasons:
- **Object storage:** the household's existing account has no free S3 storage, and S3 requests are always metered. Keeping recipe data plus images in S3 would cost a few cents a month at most, but not $0. Cloudflare R2 has 10 GB and 1M/10M operations free each month.
- **Billing safety:** AWS never stops at a limit on its own. AWS Budgets and CloudWatch alarms can fire at $0.01, but only hours after the usage happened.
- **Cold starts:** Python Lambda cold starts are slower than Cloudflare's snapshot-based Python Workers.

Azure is not worth pursuing, except possibly Static Web Apps Free as a PWA host, and Cloudflare already covers that.

**Which AWS free-tier rules apply to the household's existing account:**
- **Created before 2025-07-15:** the account is on the **legacy Free Tier**. Its 12-month offers started at signup, so by 2026-09-25 (at least 14 months later) **they have all expired**. That includes S3's 5 GB, API Gateway's 1M calls and Amplify Hosting. Only **Always Free** offers still apply. The account **can't get the new credits or the Free plan**.
- **Created on or after 2025-07-15:** it is on the Free plan or the Paid plan.
  - A Free-plan account closes after 6 months. One created before 2026-03-25 has already been closed or upgraded.
  - Credits are one-off and must be used within 12 months, so they don't count toward $0 recurring.
  - Always Free offers apply on both plans.
- **Either way, design only against the Always Free offers.**

---

## AWS

### Which free-tier rules apply to an existing account

- **The two programmes:** accounts created before 2025-07-15 stay on the **Legacy AWS Free Tier**, which has three offer types: 12 Months Free, Free Trials and Always Free. Accounts created on or after that date choose the Free plan or the Paid plan.
  - "Accounts created before July 15, 2025 will remain on the Legacy AWS Free Tier program." Source: https://docs.aws.amazon.com/hands-on/latest/control-your-costs-free-tier-budgets/control-your-costs-free-tier-budgets.html (page last updated 2025-10-08, read 2026-09-25)
  - The legacy offer types are described at https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/billing-free-tier.html (title "Trying services using AWS Free Tier (before July 15, 2025)", read 2026-09-25).
- **Legacy 12-month offers** run "for 12 months following your initial sign up date". "When your Free Tier expires … you simply pay standard, pay-as-you-go service rates". "Services with an Always Free offer allow customers to use the product for free up to specified limits as long as they are an AWS customer." Source: https://aws.amazon.com/free/legacy/free-tier-faqs (2026-09-25)
- **What that means here:** any account created before 2025-07-15 is now at least 14 months old, so every 12-month offer has lapsed.
- **No new credits for existing customers:**
  - "You would be ineligible for free plan or Free Tier credits if you have an existing AWS account or have had one in the past."
  - "No, you cannot downgrade your paid plan to the free plan."
  - When a Free plan expires, "AWS closes your account" and keeps the data for 90 days.
  - Source: https://aws.amazon.com/free/free-tier-faqs/ (2026-09-25)
- **Free plan (new accounts only):**
  - $100 of credits at signup plus up to $100 more for completing activities.
  - It "ends after six months or when your credits are fully used".
  - "Free account plan only have Always Free offerings active".
  - Paid-plan accounts pay "standard AWS billing rates for eligible usage beyond your credits or when your credits expire".
  - Source: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html (2026-09-25)
- **Services that now show credits instead of a 12-month allowance:** the S3, API Gateway and Amplify pricing pages say that "As of July 15, 2025, new AWS customers will receive up to $200 in AWS Free Tier credits" in place of a fixed allowance. Sources: https://aws.amazon.com/s3/pricing/, https://aws.amazon.com/api-gateway/pricing/, https://aws.amazon.com/amplify/pricing/ (2026-09-25)

### Free-tier limits, service by service

| Service | Free allowance | Always free or time-limited? | Source (read 2026-09-25) |
|---|---|---|---|
| **Lambda** | 1M requests + 400,000 GB-seconds per month | Always Free (listed under "Always Free" on the legacy page; usage types `Request` and `Lambda-GB-Second` are tracked as "Always Free") | https://aws.amazon.com/lambda/pricing/, https://aws.amazon.com/free/legacy/, https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/tracking-free-tier-usage.html |
| **Lambda function URLs** | No separate price line: invocations are billed as Lambda requests and duration. Auth type is `AWS_IAM` or `NONE`. | n/a | https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html |
| **API Gateway** | 1M REST + 1M HTTP API calls per month | **12 months only.** Expired for a legacy account; credits only for new accounts. | https://aws.amazon.com/api-gateway/pricing/ |
| **DynamoDB** | 25 WCU + 25 RCU (provisioned mode, Standard table class), 25 GB storage, 2.5M stream reads, per Region per payer account per month. The free tier "uses provisioned capacity"; **on-demand mode is not covered**. | Always Free (usage types tracked as "Always Free") | https://aws.amazon.com/dynamodb/pricing/provisioned/, https://aws.amazon.com/dynamodb/pricing/on-demand/ |
| **S3** | **None** for a legacy account past 12 months. New accounts get credits instead of the old 5 GB. | 12 months (legacy) / credits (new) | https://aws.amazon.com/s3/pricing/ |
| **S3 prices** (for sizing) | Storage about $0.023–0.0265/GB-month depending on region (the page showed $0.0265 for US West (Oregon)). PUT/COPY/POST/LIST $0.005 per 1,000; GET $0.0004 per 1,000. Transfer from S3 to CloudFront is free. | metered | https://aws.amazon.com/s3/pricing/ |
| **CloudFront (pay-as-you-go)** | 1 TB data out, 10M HTTP(S) requests, 2M CloudFront Functions invocations per month | Always Free | https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ |
| **CloudFront flat-rate "Free" plan** | $0/month: 1M requests + 100 GB data transfer, WAF + DDoS protection, Route 53 DNS, TLS cert, **5 GB of S3 Standard storage credits** per month. "you will not incur overage charges, regardless of how much you exceed your allowance". Sustained excess means "your traffic delivery might be adjusted" (slower or fewer edges), not billed. Up to 3 Free plans per account. Each plan covers one distribution. A WAF web ACL is required. **The account is not eligible if it "is using AWS Free Tier"**, and the docs don't define that clause (see open points). | Ongoing plan | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html, https://aws.amazon.com/cloudfront/pricing/ |
| **Amplify Hosting** | 1,000 build min, 5 GB stored, 15 GB served, 500k SSR requests per month | **12 months only** (expired for a legacy account) | https://aws.amazon.com/amplify/pricing/ |
| **Cognito** (Lite / Essentials) | 10,000 MAU per month per account (50 MAU for SAML/OIDC federation) | Always free: "does not automatically expire at the end of your 12-month AWS Free Tier term, and it is available to both existing and new AWS customers indefinitely" | https://aws.amazon.com/cognito/pricing/ |
| **AWS Budgets** | Budget monitoring and notifications at no charge. First two action-enabled budgets free; then $0.10/day each. | Always | https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/ |

**What a $0 AWS setup looks like for an existing account:**
- The Python API runs on Lambda behind a **function URL**, not API Gateway, whose free allowance has expired.
- Recipe data lives in **DynamoDB** using provisioned capacity of 25 RCU/WCU or less.
- Editor sign-in uses Cognito Lite, or a simpler app-level method.
- The PWA is served from S3 through CloudFront.

The catch is object storage. S3 has no free allowance for this account.
- The flat-rate Free plan's 5 GB credit offsets only S3 Standard *storage*. S3 *requests* (PUTs from edits and GETs on CloudFront cache misses) are still billed.
- For a household, that comes to fractions of a cent to a few cents a month. That is near-zero, **not** zero.
- Putting recipe data alongside the images in S3 increases PUT/GET volume compared with images alone.
- If the flat-rate Free plan is not available to the account, S3 storage is metered too: about 150 MB × $0.023 ≈ $0.004 a month.

### What happens when a limit is exceeded

- **Lambda, DynamoDB storage, S3, CloudFront pay-as-you-go, Cognito:** usage past the free allowance is **billed at pay-as-you-go rates** on a Paid or legacy account. There is no automatic stop. "If you go beyond these monthly allowances … you're charged at the standard AWS billing rates." Source: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html (2026-09-25)
- **DynamoDB provisioned capacity:** traffic above the provisioned RCU/WCU is throttled rather than billed, as long as auto scaling is off. Throttling is standard provisioned-mode behaviour; the pricing page does not spell it out. Storage above 25 GB is billed.
- **CloudFront flat-rate Free plan:** no overage charges. Delivery may be slowed under sustained excess (see the table above).
- **Lambda self-limits you can set:** reserved concurrency caps the function URL at 10× the reserved concurrency in requests per second, returning HTTP 429 beyond that. Setting reserved concurrency to **0** "throttles all requests to your function URL". This is the kill switch an alarm can pull. Source: https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html (2026-09-25)

### Spending alarm above $0: mechanisms, speed, stop or notify

| Mechanism | How to fire at >$0 | How fast | Stops the service? | Source (read 2026-09-25) |
|---|---|---|---|---|
| **Free Tier usage alerts** | Automatic email at **85%** of each service's Free Tier limit. On by default for standalone accounts; an Organizations management account must opt in. | Driven by Budgets data (below) | **Notify only** | https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/tracking-free-tier-usage.html |
| **AWS Budgets "Zero spend budget" template** | "notifies you after your spending exceeds AWS Free Tier limits". Alternatively, a custom monthly cost budget with an `ACTUAL`, `ABSOLUTE_VALUE` notification at $0.01 (the threshold minimum is 0). Email, or SNS to reach a phone or Lambda. | Budget data is "updated up to three times a day … typically 8–12 hours after the previous update". AWS warns that "you might incur additional costs … before AWS Budgets can notify you". | **Notify only by default.** Budget *actions* can apply an IAM deny policy or SCP, or stop EC2/RDS instances. **They can't stop Lambda or S3 directly.** | https://docs.aws.amazon.com/cost-management/latest/userguide/budget-templates.html, https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_Notification.html, https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html, https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html |
| **CloudWatch billing alarm** | Enable "Receive CloudWatch Billing Alerts". In us-east-1, alarm on `EstimatedCharges` **> 0** with a 6-hour period, sending to SNS. | Estimated charges are "sent several times daily". The alarm fires only on actual, not forecast, charges. | **Notify only**, but SNS can invoke a Lambda that sets the API function's reserved concurrency to 0: a **self-built hard stop**, hours after the fact | https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/monitor_estimated_charges_with_cloudwatch.html |
| **Budget Controls for AWS** (open-source sample, 2025-09-05) | Tag-driven stop/terminate at 90% of budget | Budgets cadence | Supports only EC2, RDS Aurora, SageMaker and OpenSearch. **Not Lambda or S3.** | https://aws.amazon.com/blogs/aws-cloud-financial-management/introducing-budget-controls-for-aws-automatically-manage-your-cloud-costs/ |

**Summary:** AWS can raise an alarm at $0.01, but only **6–12+ hours after** the spend happened, and **nothing native stops Lambda or S3**. The practical guard has three parts:
- a $0.01 actual-cost budget plus a CloudWatch `EstimatedCharges > 0` alarm, both sending to SNS;
- low reserved concurrency on the API function (for example 2–5), which caps the worst-case request rate;
- an SNS→Lambda kill switch that sets reserved concurrency to 0.

The CloudFront flat-rate Free plan is the only AWS piece that is capped by design.

### Cold starts

- Lambda scales to zero, so an idle household app pays a cold start on its first request.
- **SnapStart** supports Python 3.12 and later and cuts init time. But for Python it adds **caching and restoration charges** that are not in the free tier (for Java it is free). **Don't use SnapStart if the goal is $0.** Source: https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html (2026-09-25)
- Provisioned concurrency removes cold starts but is billed.
- Expect a FastAPI cold start of roughly 1–3 s depending on package size. That is an estimate, not a documented figure; measure it in the prototype.

### How well FastAPI runs

- Good. Lambda runs **real CPython**. The managed runtimes `python3.12`, `python3.13` and `python3.14` are on Amazon Linux 2023, with deprecation dates of 2028-10-31, 2029-06-30 and 2029-06-30. Python 3.15 is in preview, with GA expected in November 2026. Source: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html (2026-09-25)
- Native wheels such as `lxml` for recipe scraping work, unlike on Pyodide.
- FastAPI runs unchanged behind a function URL through the **AWS Lambda Web Adapter**. It is maintained by AWS, has FastAPI examples, and "Supports … Lambda Function URLs". Source: https://github.com/awslabs/aws-lambda-web-adapter (2026-09-25)

### How hard it is for agents to automate

- Easy. The AWS CLI, CloudFormation/SAM, CDK and Terraform all cover Lambda, function URLs (`AWS::Lambda::Url`), DynamoDB, S3, CloudFront and Budgets.
- Budgets templates can be exported as JSON for the CLI or CloudFormation.
- CloudFront flat-rate plans can be managed with "the AWS CLI or the PricingPlanManager API".
- GitHub Actions can deploy with OIDC-federated IAM roles. This is well trodden, though the OIDC setup is a one-time human step.
- Sources: https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html, https://docs.aws.amazon.com/cost-management/latest/userguide/budget-templates.html, https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html (2026-09-25)

### Risk of surprise bills

**Medium.** The card is on file and nothing hard-stops apart from the CloudFront flat-rate plan. A public `NONE`-auth function URL can be flooded, and alarms lag by hours.

It is mitigated in practice:
- Always Free allowances (1M requests, 400k GB-s, 25 GB DynamoDB) are orders of magnitude above household use.
- Reserved concurrency bounds the worst case.
- The alarm and kill switch described above cap the damage.

The structural issue that remains is S3: its request charges are never free for this account, so "recipe data + images in S3" is near-zero rather than zero.

---

## Azure

### Account model, card, and whether anything stops at the limit

- **Signup:**
  - "All you need is a phone number, a credit card or a debit card (non-prepaid), and a Microsoft account or a GitHub account".
  - The account includes a $200 credit for 30 days, "Free monthly amounts of 20+ popular services for 12 months (new Azure customers only)" and "65+ always-free services".
  - You must "move to pay-as-you-go pricing to continue beyond 30 days or after credit is used up".
  - Source: https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account (2026-09-25)
- **After 30 days:** "Your subscription and services are disabled when your credit runs out or expires at the end of 30 days. To continue using Azure services, you must upgrade your account." After the upgrade you're "charged only for usage beyond the free services and quantities". "Your free services and quantities expire at the end of 12 months." Source: https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/avoid-charges-free-account (ms.date 2026-03-03, read 2026-09-25)
- **Spending limit:**
  - Only credit-based offers, including the free account's $200, have one.
  - "The spending limit isn't available for subscriptions with commitment plans or with pay-as-you-go pricing." So **after the 30-day trial nothing on Azure hard-stops at the subscription level.**
  - While a spending limit is active and reached, "services that you deployed are disabled for the rest of that billing period".
  - "Custom spending limits aren't available."
  - Source: https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit (ms.date 2026-04-29, read 2026-09-25)

### Free-tier limits, service by service

| Service | Free allowance | Always free or 12 months? | Over the limit | Source (read 2026-09-25) |
|---|---|---|---|---|
| **Static Web Apps, Free plan** | 100 GB bandwidth/month **per subscription**, 10 apps. Per app: 250 MB per environment (500 MB total), 15,000 files, 2 custom domains, 3 preview environments, 30 MB request size. Built-in auth with **preconfigured providers**, and custom roles via up to 25 invitations. No SLA. | Always free | Overage bandwidth is "**Unavailable**" on Free, so the plan can't bill for it | https://learn.microsoft.com/en-us/azure/static-web-apps/quotas, https://learn.microsoft.com/en-us/azure/static-web-apps/plans |
| **Static Web Apps managed Functions** (the `/api` backend on Free) | HTTP triggers only. Runs on the Consumption plan. Python options: `python:3.9`, `python:3.10`, `python:3.11` (3.8 ended 2025-04-30). | Included with the plan | n/a | https://learn.microsoft.com/en-us/azure/static-web-apps/apis-functions, https://learn.microsoft.com/en-us/azure/static-web-apps/languages-runtimes |
| **Functions, Consumption plan (legacy)** | 1M executions + 400,000 GB-s per month per subscription | Always free grant (pay-as-you-go subscriptions) | Billed. **Linux Consumption retires 2028-09-30** and "isn't getting any new features or language versions". Python on Functions is Linux-only. | https://azure.microsoft.com/en-us/pricing/details/functions/, https://learn.microsoft.com/en-us/azure/azure-functions/consumption-plan |
| **Functions, Flex Consumption** | 250,000 executions + 100,000 GB-s per month per subscription (on-demand only; "In always ready billing, there are no free grants"). Minimum billable execution is **1,000 ms**, so at 512 MB each call costs at least 0.5 GB-s, or about 200k calls a month free. Python 3.10–3.14. | Always free grant | Billed. The required **storage account "is not included in the free grant"**. | https://azure.microsoft.com/en-us/pricing/details/functions/, https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan |
| **Cosmos DB free tier** | First 1,000 RU/s + 25 GB per account, **one free-tier account per subscription**, opt-in at creation. Provisioned throughput only (not serverless). | "lasts indefinitely for the lifetime of the account" | "throughput and storage consumed beyond these limits are billed at regular price". Provisioning ≤1,000 RU/s total keeps it free, and excess requests are rate-limited. | https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier |
| **Blob Storage** | 5 GB LRS Hot plus some operations | **12 months only** (free account) | Billed per GB and per 10,000 operations afterwards | https://azure.microsoft.com/en-us/pricing/details/storage/blobs/ |
| **App Service F1 (Linux)** | Shared CPU at **60 CPU minutes per day**, 1 GB RAM, 1 GB storage. The free-services list says "Up to 10 web or API apps with 1 GB storage and 1 hour per day". "Use of free plan for production workloads is not supported." No SLA. | Always free | Quota-bound, not billed | https://azure.microsoft.com/en-us/pricing/details/app-service/linux/, https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account |

**Recipe data alongside images in Blob:** after the first 12 months, every GB and every 10,000 operations is billed. That is tiny at household scale, but not $0. It also needs a pay-as-you-go subscription with no spending limit. Cosmos DB's lifetime free tier would be the $0 home for recipe data on Azure, but that splits data from images, which contradicts "store recipe data with the images".

### Spending alarm above $0: mechanisms, speed, stop or notify

| Mechanism | How to fire at >$0 | How fast | Stops the service? | Source (read 2026-09-25) |
|---|---|---|---|---|
| **Spending limit** (free account only) | Automatic, equal to the $200 credit | At exhaustion | **Yes.** Resources are disabled, VMs deallocated and storage made read-only. Only during the 30-day trial and not available on pay-as-you-go. | https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit |
| **Cost Management budget** | Create a small monthly budget (for example $1) with an actual-cost alert. "Alert limits support a range of 0.01% to 1000%", so 1% of $1 is $0.01. | "Cost and usage data is typically available within 8-24 hours and budgets are evaluated against these costs every 24 hours". Email within about an hour of evaluation. **For pay-as-you-go, "it could take up to 72 hours" for cost data to appear.** | **Notify only:** "Resources aren't affected, and your consumption isn't stopped." It can call an **action group** (webhook, Azure Function, runbook) to stop resources yourself. | https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets, https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data |
| Note on free usage | Cost Management does **not** include "Unbilled services (for example, free tier resources)", so there's no signal until real charges appear | — | — | https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data |

**Summary:** after the trial, Azure can alert at $0.01, but with **up to 24–72 hours of lag**, and it only notifies. Any stop has to be built with an action group. That lag is slower than AWS's.

### Cold starts

- Managed Functions and Consumption/Flex on-demand all **scale to zero**, so Python cold starts after idle are expected.
- Flex's cold-start fix is "always ready" instances, which have **no free grant**.
- The Flex host must start within 30 s.
- App Service F1 has no Always On, so it idles too.
- Source: https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan (ms.date 2026-09-15, read 2026-09-25)

### How well FastAPI runs

- Workable. `azure.functions.AsgiFunctionApp(app, …)` wraps an ASGI app such as FastAPI as a function app, on real CPython. Source: https://learn.microsoft.com/en-us/python/api/azure-functions/azure.functions.asgifunctionapp (2026-09-25)
- The **$0 path is weak**:
  - Static Web Apps managed Functions stop at **Python 3.11** (upstream end of life 2027-10, per https://devguide.python.org/versions/, read 2026-09-25) on a Linux Consumption plan that retires 2028-09-30.
  - Flex supports 3.10–3.14, but it is billed from a 1 s minimum per call and needs a paid storage account.

### How hard it is for agents to automate

- Good. The `az` CLI, Bicep/ARM and Terraform cover all of it.
  - Cosmos DB free tier: `--enable-free-tier true`, or `"enableFreeTier": true` in ARM.
  - Budgets: `az consumption budget create-with-rg`, or the Terraform/ARM examples in the Microsoft docs.
- Static Web Apps deploys from GitHub Actions by default.
- Sources: https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier, https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets (2026-09-25)

### Risk of surprise bills

**Medium-high.**
- It needs a new account, and a pay-as-you-go subscription after 30 days that can't have a spending limit.
- Blob Storage and the Functions storage account are metered once the 12-month offers end.
- Budget alerts lag by up to 72 hours on pay-as-you-go.
- Static Web Apps Free on its own is safe, because overage is unavailable. Cosmos DB free tier is safe if provisioned throughput stays at or below 1,000 RU/s.

---

## Where AWS and Azure sit against the shortlist

| Criterion | Cloudflare (1) | Vercel Hobby API (2) | **AWS (3)** | Oracle VM (4) | **Azure (5)** | Render (6) |
|---|---|---|---|---|---|---|
| Python | Pyodide, 10 ms CPU | CPython | **CPython 3.12–3.14** | any | CPython ≤3.11 free / 3.10–3.14 Flex (metered) | CPython |
| Stops at limit? | Workers/D1 yes; R2 meters | yes (30-day lockout) | **no** (CloudFront flat-rate yes) | n/a (fixed VM) | Static Web Apps yes; rest no after trial | suspends |
| $0 store for recipe data + images | R2 10 GB + ops free | Blob 1 GB (lockout) | **S3 not free for this account** (requests always metered) | 200 GB disk | Blob free 12 months only | none durable |
| Alarm above $0 | needed for R2 only (not researched here) | not needed | Budgets / CloudWatch, 6–12 h lag, notify only | not needed | Budgets, 24–72 h lag, notify only | not needed |
| Account | new | new | **existing** | new + card | new + card | new |

**Why AWS ranks third:**
- It beats Oracle: no idle reclamation and no server to run.
- It beats Render and Azure: permanent Lambda/DynamoDB allowances, a modern CPython, and an account that already exists.
- It trails Vercel for the API fallback only because Vercel **can't bill at all**, while AWS meters and alerts late. If the non-commercial clause or the 30-day lockout matters more to the household than a lagging $0.01 alarm, swap ranks 2 and 3.

**Why AWS doesn't displace Cloudflare:** R2's free operations make "recipe data + images in object storage" truly $0, and S3 doesn't for this account. Cloudflare's Workers and D1 also stop at their limits instead of billing.

---

## Open points

- **Account creation date:** the household should check the AWS account's creation date (Billing console → Free Tier page) to confirm it is on the legacy programme. Don't count on any 12-month offer either way.
- **CloudFront flat-rate eligibility:** confirm whether the flat-rate **Free plan** is offered to this account. The docs exclude accounts "using AWS Free Tier" without defining that; it likely means Free-plan accounts. If it is offered, it gives a hard-capped CDN plus 5 GB of S3 storage credit.
- **If AWS is ever chosen for the API:** put CloudFront (flat-rate, WAF rate limiting) in front of the function URL, or use `AWS_IAM` auth with CloudFront Origin Access Control. Also set low reserved concurrency and wire up the SNS→Lambda kill switch before going live.
