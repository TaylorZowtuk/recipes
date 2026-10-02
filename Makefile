# Run `make help` for the list of commands.
SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

STACKS := $(wildcard infra/stacks/*)

.PHONY: help setup check fix e2e screenshots api-client \
	py-lint py-types py-test ts-lint ts-types ts-test tf links api-drift

help: ## List the commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

setup: ## Install dependencies, the Playwright browser and the pre-commit hook
	cd backend && uv sync --locked
	cd frontend && pnpm install --frozen-lockfile && pnpm exec playwright install chromium
	uv tool run pre-commit install

check: ## Lint, type-check, unit-test, validate Terraform, check links and API-client drift (in parallel)
	@$(MAKE) --no-print-directory -j -O py-lint py-types py-test ts-lint ts-types ts-test tf links api-drift
	@echo "make check: all passed"

fix: ## Auto-format and apply safe lint fixes
	cd backend && uv run --locked ruff check --fix . && uv run --locked ruff format .
	cd frontend && pnpm exec biome check --write .
	terraform fmt -recursive infra

e2e: ## Run Playwright against a local build (Vite preview + FastAPI on moto)
	cd frontend && pnpm exec playwright test

screenshots: ## Before/after screenshots for a UI PR (BASE=origin/main by default)
	scripts/screenshots.sh

api-client: ## Regenerate the committed TypeScript API client from FastAPI's OpenAPI schema
	scripts/api-client.sh frontend/src/api/schema.ts

py-lint:
	cd backend && uv run --locked ruff check . && uv run --locked ruff format --check .
py-types:
	cd backend && uv run --locked pyright
py-test:
	cd backend && uv run --locked pytest -q
ts-lint:
	cd frontend && pnpm exec biome check .
ts-types:
	cd frontend && pnpm exec tsc -p .
ts-test:
	cd frontend && pnpm exec vitest run
tf:
	terraform fmt -check -recursive infra
	for s in $(STACKS); do \
		terraform -chdir=$$s init -backend=false -input=false >/dev/null && terraform -chdir=$$s validate -no-color; \
	done
links:
	lychee --offline --no-progress --include-fragments --exclude-path node_modules --exclude-path .venv --exclude-path .claude '**/*.md'
api-drift:
	tmp=$$(mktemp) && trap 'rm -f $$tmp' EXIT && scripts/api-client.sh $$tmp && \
	diff -u frontend/src/api/schema.ts $$tmp || { echo "API client is stale: run make api-client"; exit 1; }
