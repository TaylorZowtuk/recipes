# Infra

- Everything must stay inside AWS Always Free and under the $1-a-month alarm. Read the [hosting ADR](../docs/adr/2026-09-26-aws-hosting-fastapi-react.md) and the [stacks ADR](../docs/adr/2026-09-26-prod-and-staging-stacks.md) before adding a resource.
- Put shared resources in `modules/` and keep `stacks/prod` and `stacks/staging` as thin callers of them.
- `make check` validates offline (`init -backend=false`), so it never needs AWS credentials.
