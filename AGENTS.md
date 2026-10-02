# Plateful

An installable, offline-capable PWA for one household's recipe collection: browse and cook recipes, plan the week, shop from one shared grocery list. A FastAPI backend and a React + Vite frontend run on AWS Always Free behind CloudFront. Read [`CONTEXT.md`](CONTEXT.md) for the domain glossary, [`docs/adr/`](docs/adr/) for the decisions, and [`docs/agents/`](docs/agents/) for how agents use the issue tracker, triage labels and domain docs.

## Commands

| Command | What it does |
| --- | --- |
| `make setup` | Install dependencies, the Playwright browser and the pre-commit hook |
| `make check` | Lint, type-check, unit tests, Terraform validation, markdown links and API-client drift, in parallel. Must stay under 60 s warm |
| `make fix` | Auto-format and apply safe lint fixes |
| `make e2e` | Playwright against a local build (Vite preview + FastAPI on moto), iPhone/Pixel/desktop sizes × light/dark |
| `make screenshots` | Before (`BASE`, default `origin/main`) and after screenshots into `.screenshots/` |
| `make api-client` | Regenerate the committed TypeScript client after changing the API |

Prerequisites: uv, pnpm (via corepack), Node from `.nvmrc`, Terraform, lychee, GNU make. To run locally against staging, start the API with `AWS_PROFILE=<staging dev profile> uv run uvicorn recipes.api:app --port 8787` in `backend/`, then `pnpm exec vite` in `frontend/`.

## Layout

- `backend/`: one uv project, one `recipes` package. The API, ingest and the `enrich` CLI are modules in it. See [`backend/AGENTS.md`](backend/AGENTS.md).
- `frontend/`: one pnpm package, the PWA. Playwright tests are in `e2e/`, the generated API client in `src/api/`. See [`frontend/AGENTS.md`](frontend/AGENTS.md).
- `infra/`: Terraform `modules/` plus `stacks/prod` and `stacks/staging`. See [`infra/AGENTS.md`](infra/AGENTS.md).
- `scripts/`: helpers the Makefile calls.

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
