#!/usr/bin/env bash
# Take a pre-release Backup Snapshot of one stack ($1: staging or prod), with the AWS credentials and
# TF_STATE_BUCKET in the caller's environment, like scripts/deploy.sh: `make backup-snapshot
# STACK=<stack>`. The prod deploy job runs it before `make deploy`, so a failed snapshot blocks the
# release. It invokes the stack's snapshot function (its backup_function_name output) and waits for
# it; a stack deployed before the function existed has no such output, and is skipped.
set -euo pipefail

die() { echo "backup-snapshot: $*" >&2; exit 1; }
say() { echo "backup-snapshot: $*"; }

stack=${1:-}
repo=$(git rev-parse --show-toplevel)
root=$repo/infra/stacks/$stack
[[ -n $stack && -d $root ]] || die "usage: make backup-snapshot STACK=<$(ls "$repo/infra/stacks" | paste -sd '|')>"
[[ -n ${TF_STATE_BUCKET:-} ]] || die "set TF_STATE_BUCKET to infra/bootstrap's state_bucket output"

tf() { terraform -chdir="$root" "$@"; }
tf init -input=false -reconfigure -backend-config="bucket=$TF_STATE_BUCKET" >/dev/null
if ! fn=$(tf output -raw backup_function_name 2>/dev/null) || [[ -z $fn ]]; then
  say "$stack has no backup_function_name output yet (its snapshot function comes with this deploy), so there's nothing to snapshot with. Skipping."
  exit 0
fi

out=$(mktemp)
trap 'rm -f "$out"' EXIT
say "invoking $fn for a pre-release snapshot; this waits for it (up to 15 minutes)."
# Synchronous, with no read timeout, and no CLI retry: a retry would start a second snapshot.
err=$(AWS_MAX_ATTEMPTS=1 aws lambda invoke --function-name "$fn" \
  --cli-binary-format raw-in-base64-out --payload '{"kind":"pre-release"}' \
  --cli-read-timeout 0 --query FunctionError --output text "$out")
if [[ -n $err && $err != None ]]; then
  echo "backup-snapshot: $fn failed ($err):" >&2
  cat "$out" >&2
  echo >&2
  die "no pre-release snapshot, so the release stops here. See $fn's CloudWatch logs."
fi
say "done: $(cat "$out")"
