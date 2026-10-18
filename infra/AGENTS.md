# Infra

- Everything must stay inside AWS Always Free and under the $1-a-month alarm. Read the [hosting ADR](../docs/adr/2026-09-26-aws-hosting-fastapi-react.md) and the [stacks ADR](../docs/adr/2026-09-26-prod-and-staging-stacks.md) before adding a resource.
- Put shared resources in `modules/` (see [its README](modules/README.md)) and keep `stacks/prod` and `stacks/staging` as thin callers of `modules/stack` with their own values.
- `make check` validates `bootstrap/` and every stack offline (`init -backend=false`), so it never needs AWS credentials. Commit each root's `.terraform.lock.hcl`; after changing a provider version, run `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64` in that root (in `make shell`).
- Terraform's exact version is pinned once, as the `hashicorp/terraform` image in `docker/Dockerfile`. Each root's `required_version` (`~> 1.16`) allows it and the minor releases Dependabot bumps it to.
- Every resource a stack makes is named `plateful-<stack>-…` (`modules/stack-access` decides the names). The deploy role may change only resources with its stack's prefix, CloudFront distributions tagged with its `Stack`, and its own state key, and every IAM role or user a stack makes must carry the stack's permissions boundary. A new kind of resource needs a matching grant in `modules/github-deploy-role`.
- CloudFront uses only managed cache, origin request and response headers policies, and at most five behaviours, because the Free plan forbids custom policies. `/api/*` is not cached yet: the managed policies that key on query strings also forward `Host`, which a function URL rejects. Caching versioned reads such as `/api/collection?v=` is an open decision.
- The Lambda code is owned by Terraform (`filename` and `source_code_hash` from `backend/dist/lambda.zip`), so build the zip before `plan` or `apply`.

## Roots

- `bootstrap/`: the account's one-time setup. The state bucket, GitHub's OIDC provider, and each stack's deploy role and permissions boundary. A human applies it with temporary admin credentials, the documented exception to "nothing local holds prod credentials".
- `stacks/prod`, `stacks/staging`: one stack each, deployed by GitHub Actions through the stack's deploy role. Staging also has the dev user behind `make dev STAGING_PROFILE=…`; its access key is made by hand.

Each root's S3 backend leaves out the bucket, so init with `terraform init -backend-config="bucket=plateful-tfstate-<account id>"`. State locks with S3's native lock file.

## Bootstrapping a fresh account

The state bucket has to exist before any state can live in it, so `bootstrap/` is applied in two steps:

1. Apply with local state: `printf 'terraform {\n  backend "local" {}\n}\n' > bootstrap/backend_override.tf`, then `terraform -chdir=bootstrap init` and `terraform -chdir=bootstrap apply`.
2. Move the state into its own bucket: `rm bootstrap/backend_override.tf`, then `terraform -chdir=bootstrap init -migrate-state -backend-config="bucket=plateful-tfstate-<account id>"`, and delete the local `terraform.tfstate*` files.

Then each stack's first apply can run from its deploy workflow. After a stack's first apply, a human subscribes its distribution to the CloudFront Free plan with the `distribution_arn` and `web_acl_arn` outputs, and sets the real values of its SSM parameters under `/plateful/<stack>/`.
