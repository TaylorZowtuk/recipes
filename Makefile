# Run `make help` for the list of commands. On the host, each command runs in the toolchain
# container (docker/Dockerfile, compose.yaml); inside it, IN_CONTAINER is set and the recipes
# below the `else` do the work.
SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

.PHONY: help setup check fix e2e screenshots api-client dev shell gitleaks check-playwright-image \
	deps dev-api dev-web py-lint py-types py-test ts-lint ts-types ts-test tf links api-drift

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
# Make the volume mountpoints so Docker doesn't create them owned by root, and the shared cache.
PREPARE := mkdir -p frontend/node_modules backend/.venv && docker volume create recipes-cache >/dev/null
RUN = $(PREPARE) && $(COMPOSE) --progress quiet run --rm --build $(RUN_FLAGS) tools

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
	$(PREPARE)
	$(COMPOSE) $(if $(STAGING_PROFILE),-f compose.yaml -f compose.staging.yaml) up --build api web

shell: ## A shell in the toolchain container
	$(RUN) bash

gitleaks: RUN_FLAGS := -T
gitleaks: # The pre-commit hook: scan the diff on stdin for secrets
	@$(RUN) gitleaks stdin --redact --verbose --no-banner

check-playwright-image:
	@scripts/check-playwright-image.sh

else

STACKS := $(wildcard infra/stacks/*)

deps:
	cd backend && uv sync --locked --quiet
	cd frontend && pnpm install --frozen-lockfile --silent

check: deps
	@$(MAKE) --no-print-directory -j -O py-lint py-types py-test ts-lint ts-types ts-test tf links api-drift
	@echo "make check: all passed"

fix: deps
	cd backend && uv run --locked ruff check --fix . && uv run --locked ruff format .
	cd frontend && pnpm exec biome check --write .
	terraform fmt -recursive infra

e2e: deps
	cd frontend && pnpm exec playwright test

screenshots: deps
	scripts/screenshots.sh

api-client: deps
	scripts/api-client.sh frontend/src/api/schema.ts

dev-api:
	cd backend && uv run --locked uvicorn recipes.api:app --host 0.0.0.0 --port 8787 --reload
dev-web:
	cd frontend && pnpm install --frozen-lockfile --silent && pnpm exec vite --host 0.0.0.0 --port 5173 --strictPort

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
		terraform -chdir=$$s init -backend=false -input=false >/dev/null && terraform -chdir=$$s validate -no-color || exit 1; \
	done
links:
	lychee --offline --no-progress --include-fragments --exclude-path node_modules --exclude-path .venv --exclude-path .claude '**/*.md'
api-drift:
	tmp=$$(mktemp) && trap 'rm -f $$tmp' EXIT && scripts/api-client.sh $$tmp && \
	diff -u frontend/src/api/schema.ts $$tmp || { echo "API client is stale: run make api-client"; exit 1; }

endif
