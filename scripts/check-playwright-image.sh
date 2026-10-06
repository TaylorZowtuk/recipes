#!/usr/bin/env bash
# Fail fast when the toolchain image's Playwright differs from the @playwright/test version that
# frontend/pnpm-lock.yaml resolves: the image's browsers only work with their own release.
set -euo pipefail
cd "$(dirname "$0")/.."

image=$(sed -n 's|^FROM mcr\.microsoft\.com/playwright:v\([0-9.]*\)-.*|\1|p' docker/Dockerfile)
locked=$(sed -n "s|^  '@playwright/test@\([0-9.]*\)':\$|\1|p" frontend/pnpm-lock.yaml | sort -u)

if [[ -z $image || -z $locked || $image != "$locked" ]]; then
  echo "Playwright mismatch: docker/Dockerfile uses the v${image:-?} image but frontend/pnpm-lock.yaml" \
    "resolves @playwright/test ${locked:-?}. Bump the image tag or the package so they match." >&2
  exit 1
fi
