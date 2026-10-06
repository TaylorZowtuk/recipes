#!/usr/bin/env bash
# The pre-commit hook: scan the staged changes for secrets with gitleaks from the toolchain image.
set -euo pipefail
git diff --cached --unified=0 --no-color | make --no-print-directory gitleaks
