#!/usr/bin/env bash
# The Compose project name of the worktree at $1: its folder name, then a hash of its path, so two
# worktrees never share containers, volumes or ports and `docker volume ls` shows whose is whose.
set -euo pipefail
printf 'recipes-%s-%s\n' "$(basename "$1" | tr A-Z a-z | tr -c 'a-z0-9\n' - | cut -c1-30)" \
  "$(printf %s "$1" | git hash-object --stdin | cut -c1-7)"
