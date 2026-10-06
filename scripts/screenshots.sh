#!/usr/bin/env bash
# Take before/after screenshots of every page in frontend/screenshots/pages.spec.ts.
# "after" is the working tree; "before" is BASE (default origin/main), built in a temporary worktree.
# Output: .screenshots/{before,after}/<viewport>-<scheme>/<page>.png
# Runs in the toolchain container (`make screenshots`).
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
base=${BASE:-origin/main}
out="$repo/.screenshots"
playwright=$(command -v playwright) # the working tree's, even once PATH prefers the base's bins
rm -rf "$out"

shoot() { # $1 = before|after, $2 = app root
  (cd "$repo/frontend" && APP_ROOT="$2" SCREENSHOT_DIR="$out/$1" PLAYWRIGHT_TEST_DIR=screenshots \
    "$playwright" test --reporter=list)
}

shoot after "$repo"

before=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$before" >/dev/null 2>&1 || true' EXIT
git -C "$repo" worktree add --detach "$before" "$base" >/dev/null
if [[ -d "$before/frontend" ]]; then
  # The base gets its own dependencies inside the container, apart from the working tree's volumes.
  export UV_PROJECT_ENVIRONMENT="$before/backend/.venv" VITE_CACHE_DIR="" \
    PATH="$before/frontend/node_modules/.bin:$PATH"
  (cd "$before/backend" && uv sync --locked --quiet)
  (cd "$before/frontend" && pnpm install --frozen-lockfile --silent)
  shoot before "$before"
else
  echo "$base has no frontend yet: no before screenshots."
fi

echo "Screenshots in ${out#"$repo"/}/"
