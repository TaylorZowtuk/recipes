# Infra

- Everything must stay inside AWS Always Free and under the $1-a-month alarm. Read the [hosting ADR](../docs/adr/2026-09-26-aws-hosting-fastapi-react.md) and the [stacks ADR](../docs/adr/2026-09-26-prod-and-staging-stacks.md) before adding a resource.
- Put shared resources in `modules/` (see [its README](modules/README.md)) and keep `stacks/prod` and `stacks/staging` as thin callers of `modules/stack` with their own values.
- `make check` validates `bootstrap/` and every stack offline (`init -backend=false`), and runs `terraform test` in `tests/` against mock providers (the Free plan, capacity and deploy-role rules), so it never needs AWS credentials. Add a run there when a module gains a rule a later edit could break. Commit each root's `.terraform.lock.hcl` (`tests/` is a root too); after changing a provider version, run `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64` in that root (in `make shell`).
- Terraform's exact version is pinned once, as the `hashicorp/terraform` image in `docker/Dockerfile`. Each root's `required_version` (`~> 1.16`) allows it and the minor releases Dependabot bumps it to.
- `modules/stack-access` decides every name. A stack's resources are named `plateful-<stack>-…`, except its table (`plateful-<stack>`) and SSM parameters (`/plateful/<stack>/…`). The deploy role is `plateful-deploy-<stack>`, outside the prefix on purpose. The deploy role may change only its stack's prefixed resources, table and parameters, the CloudFront distributions tagged with its `Stack`, and its own state key; of bootstrap's state it may only read the key. Every IAM role or user a stack makes must carry the stack's permissions boundary. A new kind of resource needs a matching grant in `modules/github-deploy-role`.
- CloudFront uses only managed cache, origin request and response headers policies, and at most five behaviours, because the Free plan forbids custom policies. `/api/*` is not cached yet: the managed policies that key on query strings also forward `Host`, which a function URL rejects. Caching versioned reads such as `/api/collection?v=` is an open decision.
- The Lambda code is owned by Terraform (`filename` and `source_code_hash` from `backend/dist/lambda.zip`), so build the zip before `plan` or `apply`.

## Roots

- `bootstrap/`: the account's one-time setup. The state bucket, GitHub's OIDC provider, and each stack's deploy role, permissions boundary and CloudFront OACs. OACs carry no tags and have generated IDs, so no deploy role could be scoped to its own; each stack reads their IDs from bootstrap's state (`terraform_remote_state`), and an OAC change needs a bootstrap apply before the stacks' next deploy. A human applies it with temporary admin credentials, the documented exception to "nothing local holds prod credentials".
- `stacks/prod`, `stacks/staging`: one stack each, deployed by GitHub Actions through the stack's deploy role. Staging also has the dev user behind `make dev STAGING_PROFILE=…`; its access key is made by hand.

Each root's S3 backend leaves out the bucket, so init with `terraform init -backend-config="bucket=plateful-tfstate-<account id>"`. State locks with S3's native lock file.

## Deploys

[`scripts/deploy.sh`](../scripts/deploy.sh) (`make deploy STACK=<stack>`) is the whole deploy, in CI and by hand: `init` with `-backend-config`, `apply` with the zip `make build` made (auto-approved only under `CI`), then the PWA bundle to the stack's `pwa_bucket` output. It never rebuilds, so prod gets the bytes staging tested.

- Upload order: `assets/*` first with `Cache-Control: public, max-age=31536000, immutable`, then every other file except `index.html` with `no-cache`, then `index.html`. Each file gets its Content-Type from its extension; an unknown extension fails the deploy before anything is uploaded, so add it to `content_type` there.
- Old assets are never deleted, because phones on the previous release, and their service workers' precaches, still ask for them.
- No CloudFront invalidation: the no-cache files are revalidated within the default behaviour's 1 s minimum TTL, and asset names change with their contents.
- A deploy that needs a new kind of AWS call needs a matching grant in `modules/github-deploy-role`, applied by a human through `bootstrap/`.

## Human steps

Run [`scripts/aws-setup.sh`](../scripts/aws-setup.sh) on the host. It walks through every step only the human can do, in order, checks what is already done, and is safe to re-run: temporary admin credentials, the two-step `bootstrap/` apply, the `staging` and `prod` GitHub environments (both deploy from `main` only, prod with you as required reviewer; a re-run keeps rules you changed by hand unless you say to overwrite) and their variables, the first deploy of each stack, the CloudFront Free plan subscription per distribution, the SSM SecureStrings, the staging dev user's access key in `~/.aws`, and a smoke check of both URLs. Every AWS and Terraform command runs in the toolchain container through `make aws`. The admin credentials stay in the wizard's memory, and no secret is printed or written to the repo.

For reference, the bootstrap is two steps because the state bucket has to exist before any state can live in it:

1. Apply with local state: `printf 'terraform {\n  backend "local" {}\n}\n' > bootstrap/backend_override.tf`, then `terraform -chdir=bootstrap init` and `terraform -chdir=bootstrap apply`.
2. Move the state into its own bucket: `rm bootstrap/backend_override.tf`, then `terraform -chdir=bootstrap init -migrate-state -backend-config="bucket=plateful-tfstate-<account id>"`, and delete the local `terraform.tfstate*` files.

The Free plan subscription is `aws pricing-plan-manager create-subscription --region us-east-1 --plan-family CloudFront --plan-tier FREE --resource-arns <distribution_arn> <web_acl_arn>`, with the stack's outputs. An SSM parameter still at version 1 holds Terraform's placeholder; set the real value with `aws ssm put-parameter --overwrite`, which Terraform never reverts.
