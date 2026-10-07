#!/usr/bin/env bash
# The pre-commit hook: scan the staged changes for secrets with gitleaks from the toolchain image.
set -euo pipefail
# Only added lines count, so a commit that removes a secret isn't blocked.
git diff --cached --unified=0 --no-color | sed '/^-/d' | make --no-print-directory gitleaks
