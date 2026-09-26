# Separate prod and staging stacks in one AWS account, with an approval gate between them

The app runs as two stacks: **prod** (stable, tested releases) and **staging** (development and pre-release checks). Both live in the **same AWS account**. A separate staging account was rejected because a new account would land on the post-2025 AWS Free plan, which ends in closure or a paid upgrade, can't get the CloudFront Free plan, and within an Organization shares the Free Tier allowances anyway. The two stacks together stay well under the $1-a-month alarm set in [the hosting ADR](2026-09-26-aws-hosting-fastapi-react.md).

## How the account is shared

- Each stack has its own CloudFront Free plan distribution (the account may hold 3), function URL, buckets, tables, Cognito user pool and Terraform state.
- Lambda, DynamoDB and Cognito free allowances are account-wide, so Terraform keeps the combined DynamoDB provisioned capacity at or below 25 RCU/WCU, for example prod 10/10, staging 5/5 and the rest in reserve for indexes.
- The $1 budget, the alarms and the kill switch cover both stacks.

## Testing layers

1. **Automated tests** (the one fast command and CI) use local fakes for AWS (moto / DynamoDB Local). They never touch a real stack.
2. **Local development** runs the Vite dev server and FastAPI on the laptop, pointed at **staging's** data stores and user pool through a dev AWS profile. Nothing local ever holds prod credentials.
3. **Pre-release checks** happen on the staging URL: Playwright end-to-end tests plus a manual check on a phone.

## Staging data

Automated end-to-end tests run against **seed data** (a small, known set of recipes and images). For manual checks before a release, staging is refreshed by **restoring prod's backup** into it. That refresh doubles as the backup/restore drill, so the backup format must restore into a different stack than the one it came from.

## Release flow

A merge to `main` makes CI deploy to staging and run the end-to-end tests there. A human then approves the release in a GitHub Actions environment, and **the same build and Terraform configuration** deploy to prod. Deploys assume per-stack OIDC roles, so there are no long-lived AWS keys, and only the prod role can write to prod.
