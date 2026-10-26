# Plateful

An installable, offline-capable PWA for one household's recipe collection: browse and cook recipes, plan the week, shop from one shared grocery list. A FastAPI backend and a React + Vite frontend run on AWS Always Free behind CloudFront. Read [`CONTEXT.md`](CONTEXT.md) for the domain glossary, [`docs/adr/`](docs/adr/) for the decisions, and [`docs/agents/`](docs/agents/) for how agents use the issue tracker, triage labels and domain docs.

## Commands

| Command | What it does |
| --- | --- |
| `make setup` | Build the toolchain image, install dependencies and the pre-commit hook |
| `make check` | Lint, type-check, unit tests, Terraform validation and tests, shell and workflow lint, markdown links and API-client drift, in parallel. Must stay under 60 s warm |
| `make fix` | Auto-format and apply safe lint fixes |
| `make e2e` | Playwright against a local build (Vite preview + FastAPI on moto), iPhone (WebKit), Pixel and desktop (Chromium) × light/dark. `E2E_BASE_URL=<url> make e2e` runs it against a deployed stack instead: only tests tagged `@deployed` (those that test what only a deployed stack shows: the real API through CloudFront, CloudFront's headers and assets, the service worker against real caching), on `iphone-light` and `desktop-dark`, to stay under the WAF's per-IP rate limit. `make e2e` passes no arguments, so to override that with `--grep`, `--grep-invert` or `--project`, run `cd frontend && pnpm exec playwright test --grep …` from `make shell` |
| `make screenshots` | Before (`BASE`, default `origin/main`) and after screenshots into `.screenshots/` |
| `make api-client` | Regenerate the committed TypeScript client after changing the API |
| `make lambda` | Build the API's Lambda zip (arm64, run by the Lambda Web Adapter) into `backend/dist/lambda.zip` |
| `make build` | Build a release: the Lambda zip and the PWA bundle in `frontend/dist` |
| `make deploy STACK=<staging\|prod>` | Apply the stack with the built zip and upload the PWA bundle, using the AWS credentials and `TF_STATE_BUCKET` in your environment. CI's deploy jobs run it |
| `make smoke URL=<url>` | Check a deployed stack's responses through CloudFront (status, Content-Type, `Cache-Control`, `X-Robots-Tag`, and an OAC-signed POST) |
| `make kill-switch-test STACK=<stack>` | Trip the stack's kill switch with a test message on its own SNS topic, wait for the API to reserve 0, check the API is throttled and the PWA still serves, then reset it. Uses the AWS credentials and `TF_STATE_BUCKET` in your environment; CI runs it on staging |
| `make kill-switch-reset STACK=<stack>` | Re-enable the stack's API after its kill switch tripped (check the bill first), with the AWS credentials and `TF_STATE_BUCKET` in your environment. The [Kill switch reset](.github/workflows/kill-switch-reset.yml) workflow runs it with the stack's deploy role |
| `make dev` | FastAPI and the Vite dev server with hot reload, at <http://localhost:5173> (`DEV_PORT=<port>` to change it). The API runs on a fake DynamoDB (moto) holding a synthetic Collection, which starts afresh on every reload |
| `make browser URL=<url>` | A watched browser: Chromium headed on a virtual display, which the human sees and types into through noVNC, published on 127.0.0.1 behind a one-time password the command prints. `URL` is an origin with no path: local `make dev` (`http://localhost:<port>`, with `make dev DEV_PORT=<port>` running in the same worktree) or exactly staging's URL; anything else, prod included, and CI are refused. Stops itself after `TIME_LIMIT` (default `2h`). See [Watched browser](#watched-browser) |
| `make browser-run < step.mjs` | Run a step script against this worktree's running watched browser (start it with `make browser` first) over CDP; it writes screenshots to `OUT` (default `.screenshots/browser`). See [`frontend/AGENTS.md`](frontend/AGENTS.md) |
| `make browser-stop` | Remove the watched browser's container and network. `make clean` runs it too |
| `make shell` | A shell in the toolchain container, with dependencies installed |
| `make clean` | Remove this worktree's containers, volumes and image. Run it before deleting a worktree |

Prerequisites: Docker with Compose v2, git, GNU make 4 or later (on macOS, `brew install make` and run `gmake`) and uv. Nothing else goes on the host: every command runs in the toolchain container ([`docker/Dockerfile`](docker/Dockerfile), [`compose.yaml`](compose.yaml)), and CI runs the same `make` commands. The pre-commit hook runs gitleaks from the same image, so commits need Docker running, and the first commit in a fresh worktree waits for the image to build.

- **Never run uv, pnpm, pytest or Node on the host.** uv is there only for pre-commit. Running them on the host installs a second, host copy of the dependencies over the volumes. Host editors and language servers see empty `node_modules` and `.venv` directories, so trust `make check` over their unresolved-import errors.
- For anything without a `make` command, use `make shell`. For example: a single test (`cd backend && uv run pytest tests/test_sync.py`, `cd frontend && pnpm exec vitest run src/syncStatus.test.ts`, `cd frontend && pnpm exec playwright test --project iphone-light`), or adding a dependency (`pnpm add` in `frontend/`, `uv add` in `backend/`; restart `make dev` afterwards).
- Containers run as your user, so files they write into the checkout are yours. `frontend/node_modules` and `backend/.venv` are Docker volumes mounted into the checkout (on the host they're empty directories), and the tool caches are a volume shared by every worktree. If a volume goes stale, `make clean` and rerun.
- Each worktree gets its own Compose project, so worktrees can run commands at the same time. Only `make dev` and `make browser` publish ports. `make browser` lets Docker pick a free one for noVNC on 127.0.0.1, but give a second worktree's dev stack its own, for example `make dev DEV_PORT=5174`.
- Versions: Node comes from `.nvmrc`, Python from `backend/.python-version`, the Playwright image from the `@playwright/test` version in `frontend/pnpm-lock.yaml`, and every other image tag (Terraform, uv, lychee, gitleaks, actionlint, shellcheck, the AWS CLI) from `docker/Dockerfile`.
- To run locally against staging, use `make dev STAGING_PROFILE=<staging dev profile>`. It mounts `~/.aws` read-only into the API container, so the profile must use static keys and set a region, and points FastAPI at staging's table, images bucket and SSM parameters in place of the fake. It runs `recipes.staging:app`, the stack's API plus the bucket's images at `/images/*`, which CloudFront serves on a stack. The bucket name ends in the account ID, which comes from `STAGING_ACCOUNT_ID` or else the setup wizard's `.aws-setup.env` (in this checkout or the main one); with neither, `make dev` stops and says so. Name the staging profile, never prod's: the whole of `~/.aws` is visible to the container.

## Layout

- `backend/`: one uv project, one `recipes` package. The API, ingest and the `enrich` CLI are modules in it. See [`backend/AGENTS.md`](backend/AGENTS.md).
- `frontend/`: one pnpm package, the PWA. Playwright tests are in `e2e/`, the generated API client in `src/api/`. See [`frontend/AGENTS.md`](frontend/AGENTS.md).
- `infra/`: Terraform `modules/`, `stacks/prod` and `stacks/staging`, plus `bootstrap/` for the account's one-time setup and `tests/` (`terraform test` on mock providers). See [`infra/AGENTS.md`](infra/AGENTS.md).
- `docker/`, `compose.yaml`: the toolchain image and the containers every command runs in.
- `scripts/`: helpers the Makefile calls, and `aws-setup.sh`, the wizard for the AWS and GitHub steps only the human can do.

## Deploys

A push to `main` runs [`deploy.yml`](.github/workflows/deploy.yml): `make build` once, then `make deploy STACK=staging`, then `make smoke` against staging's URL, then `make kill-switch-test STACK=staging` (the spend guard's test: it trips staging's kill switch and resets it), then `make e2e` against staging, then the same build to prod once the human approves the `prod` environment, followed by `make smoke` there. Each deploy job assumes its stack's deploy role through GitHub OIDC; the role ARN, state bucket and region are variables on the GitHub environment, and no AWS key is stored anywhere. Both environments deploy from `main` only, so a manual run from another branch can't reach either stack; only `prod` has a required reviewer. Deploys run one at a time per stack and are never cancelled mid-apply. The one-time setup (account, bootstrap, Lambda quota, billing alerts and spend alarm emails, GitHub environments, Free plan, SSM secrets and each stack's Google OAuth client ID, the watched browser's test account, dev profile) is [`scripts/aws-setup.sh`](scripts/aws-setup.sh), run by the human on the host; see [`infra/AGENTS.md`](infra/AGENTS.md).

## Watched browser

For a manual check that needs a person, such as signing in as an editor on staging, `make browser` shows a real Chromium to the human through noVNC while you drive it with step scripts over CDP. Why it's built this way, and what it doesn't protect: [the ADR](docs/adr/2026-10-25-watched-browser.md).

- Never in CI, never against prod (the target refuses both). Use local `make dev` when the check doesn't need staging.
- Ask the human first. Then run `make browser URL=<url>` and pass on the block it prints, with the steps: forward the printed port (VS Code's Ports panel, or `ssh -L <port>:127.0.0.1:<port> <box>`), open the printed `/vnc.html` link, type the one-time password, and sign in with the **test account**, never a household account. The test account comes from the setup wizard's "Test account for the watched browser" stage, which also writes `STAGING_URL` to `.aws-setup.env`, the only place `make browser` reads it from.
- Never read, print or save cookies, storage, request headers, HARs, traces or tokens, in a step script or otherwise. Never commit screenshots of Google's sign-in pages.
- Keep under staging's WAF limit (1000 requests per 5 minutes per IP, shared with everything else on this box) and the API's reserved concurrency (3 on staging). Don't run it while a deploy runs staging's kill-switch test.
- Always `make browser-stop` when you're done, even if the time limit would stop it.

## Hard rules

- **The repo is public.** It never holds scraped recipe content, saved web pages or recipe images. Fixtures are synthetic: recipes written for the repo, generated placeholder images and hand-written minimal schema.org HTML. When ingest turns up a new edge case, consider adding a fixture for it.
- **No credentials of any kind**, not only prod's. Local development reaches staging through an AWS profile in `~/.aws`. The pre-commit hook runs gitleaks.
- **Use the glossary's vocabulary** in code, tests, issues and PRs.

## Keeping docs current

- A PR that introduces or changes a domain term updates `CONTEXT.md` in the same PR.
- A PR that departs from an ADR adds a new dated ADR, and the old one gets a "Superseded by …" line at the top. ADRs are never edited silently.
- A PR that changes commands or the layout updates this file.

## Issues and PRs

- A `ready-for-agent` issue is a vertical, demoable slice sized for one session. Work it in your own worktree and open a PR with `Closes #n`. The human merges.
- A PR that changes UI includes before/after screenshots from `make screenshots`. Check your UI in a real browser before opening the PR.
- New issues go through `needs-triage`.

## Parallel agents

Assume another agent is working in this repo right now.

- Give each agent its own worktree and branch. When you spawn a subagent that may edit files, commit, or run git, use worktree isolation.
- Leave the main checkout's branch and working tree as you found them.
- Other agents may be editing shared GitHub issue bodies, such as the wayfinder map. Re-fetch the body right before you edit it and change only your part. Then re-fetch it to confirm everyone's edits survived.

## Merging to main

`main` is protected: every change reaches it through a PR, and PRs merge by squash (`gh pr merge <pr> --squash`). Don't push to `main` directly.

## Wayfinder artifacts

Work on a wayfinder ticket leaves either a **one-off artifact** (research, prototypes: keep it as a closed PR labelled `wayfinder:artifact`) or a **permanent artifact** (ADRs, `CONTEXT.md`, agent docs: open a normal PR and leave it for the human to merge). Follow [the wayfinder artifacts steps](docs/agents/wayfinder-artifacts.md). For a permanent artifact, **tell the human, clearly and separately from the rest of your report, that the PR needs merging to `main`**, and what depends on it.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on TaylorZowtuk/recipes, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
