#!/usr/bin/env bash
# Generate the TypeScript API client types from FastAPI's OpenAPI schema into $1.
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
out=$(realpath "$1")
schema=$(mktemp --suffix=.json)
trap 'rm -f "$schema"' EXIT

(cd "$repo/backend" && uv run --locked --quiet python -m recipes.openapi) >"$schema"
(cd "$repo/frontend" && pnpm exec openapi-typescript "$schema" --output "$out" >/dev/null)
