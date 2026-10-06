# Run `make help` for the list of commands. On the host, each command runs in the toolchain
# container (docker/Dockerfile, compose.yaml); inside it, IN_CONTAINER is set and the recipes
# below the `else` do the work.
SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

.PHONY: help setup check fix e2e screenshots api-client dev pnpm shell gitleaks check-playwright-image \
	deps backend-deps frontend-deps dev-api dev-web py-lint py-types py-test ts-lint ts-types ts-test tf links api-drift

help: ## List the commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

ifndef IN_CONTAINER

# One Compose project per worktree, so worktrees never share containers, volumes or ports.
export COMPOSE_PROJECT_NAME := recipes-$(shell printf %s '$(CURDIR)' | git hash-object --stdin | cut -c1-8)
export NODE_VERSION := $(patsubst v%,%,$(file < .nvmrc))
export HOST_UID := $(shell id -u)
export HOST_GID := $(shell id -g)
export GIT_COMMON_DIR := $(abspath $(shell git rev-parse --git-common-dir))
COMPOSE := docker compose
RUN = $(COMPOSE) --progress quiet run --rm --build $(RUN_FLAGS) tools

setup: ## Build the toolchain image, install dependencies and the pre-commit hook
	$(COMPOSE) build tools
	$(RUN) make deps
	uv tool install --quiet pre-commit && uv tool run pre-commit install

check: ## Lint, type-check, unit-test, validate Terraform, check links and API-client drift (in parallel)
	$(RUN) make check

fix: ## Auto-format and apply safe lint fixes
	$(RUN) make fix

e2e: check-playwright-image ## Run Playwright against a local build (Vite preview + FastAPI on moto)
	$(RUN) make e2e

screenshots: check-playwright-image ## Before/after screenshots for a UI PR (BASE=origin/main by default)
	$(RUN) make screenshots BASE=$(or $(BASE),origin/main)

api-client: ## Regenerate the committed TypeScript API client from FastAPI's OpenAPI schema
	$(RUN) make api-client

dev: ## FastAPI + Vite with hot reload on localhost:$DEV_PORT (5173); STAGING_PROFILE=<profile> for staging
	$(COMPOSE) $(if $(STAGING_PROFILE),-f compose.yaml -f compose.staging.yaml) up --build api web

pnpm: ## Run pnpm on the frontend, e.g. ARGS="add -D <package>"
	$(RUN) make pnpm ARGS='$(ARGS)'

shell: ## A shell in the toolchain container
	$(RUN) bash

gitleaks: RUN_FLAGS := -T
gitleaks: # The pre-commit hook: scan the diff on stdin for secrets
	@$(RUN) gitleaks stdin --redact --verbose --no-banner

check-playwright-image:
	@scripts/check-playwright-image.sh

else

STACKS := $(wildcard infra/stacks/*)
# pnpm works on copies of these in /work, so node_modules lands in the volume there. pnpm may
# create pnpm-workspace.yaml (for build-script approvals), so it's copied whenever it exists.
PNPM_FILES = package.json pnpm-lock.yaml $$(ls pnpm-workspace.yaml 2>/dev/null)

deps: backend-deps frontend-deps
backend-deps:
	cd backend && uv sync --locked --quiet
frontend-deps:
	cd frontend && cp $(PNPM_FILES) /work/
	cd /work && pnpm install --frozen-lockfile --silent

pnpm: frontend-deps
	cd /work && pnpm $(ARGS)
	cd /work && cp $(PNPM_FILES) /work/repo/frontend/

check: deps
	@$(MAKE) --no-print-directory -j -O py-lint py-types py-test ts-lint ts-types ts-test tf links api-drift
	@echo "make check: all passed"

fix: deps
	cd backend && uv run --locked ruff check --fix . && uv run --locked ruff format .
	cd frontend && biome check --write .
	terraform fmt -recursive infra

e2e: deps
	cd frontend && playwright test

screenshots: deps
	scripts/screenshots.sh

api-client: deps
	scripts/api-client.sh frontend/src/api/schema.ts

dev-api:
	cd backend && uv run --locked uvicorn recipes.api:app --host 0.0.0.0 --port 8787 --reload
dev-web: frontend-deps
	cd frontend && vite --host 0.0.0.0 --port 5173 --strictPort

py-lint:
	cd backend && uv run --locked ruff check . && uv run --locked ruff format --check .
py-types:
	cd backend && uv run --locked pyright
py-test:
	cd backend && uv run --locked pytest -q
ts-lint:
	cd frontend && biome check .
ts-types:
	cd frontend && tsc -p .
ts-test:
	cd frontend && vitest run
tf:
	terraform fmt -check -recursive infra
	for s in $(STACKS); do \
		export TF_DATA_DIR=/work/terraform/$$(basename $$s); \
		terraform -chdir=$$s init -backend=false -input=false >/dev/null && terraform -chdir=$$s validate -no-color || exit 1; \
	done
links:
	lychee --offline --no-progress --include-fragments --exclude-path .claude '**/*.md'
api-drift:
	tmp=$$(mktemp) && trap 'rm -f $$tmp' EXIT && scripts/api-client.sh $$tmp && \
	diff -u frontend/src/api/schema.ts $$tmp || { echo "API client is stale: run make api-client"; exit 1; }

endif
