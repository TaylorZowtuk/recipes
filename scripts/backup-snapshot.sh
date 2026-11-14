#!/usr/bin/env bash
# Take a pre-release Backup Snapshot of one stack ($1: staging or prod), with the AWS credentials and
# TF_STATE_BUCKET in the caller's environment, like scripts/deploy.sh: `make backup-snapshot
# STACK=<stack>`. The prod deploy job runs it before `make deploy`, so a failed snapshot blocks the
# release. It starts the stack's snapshot function (its backup_function_name output) and watches the
# backup bucket for the new snapshot; a stack deployed before the function existed has no such
# output, and is skipped.
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
# A state that can't be read fails here; only a missing output means there's no function yet.
outputs=$(tf output -json)
fn=$(jq -r '.backup_function_name.value // empty' <<<"$outputs")
bucket=$(jq -r '.backup_bucket.value // empty' <<<"$outputs")
if [[ -z $fn ]]; then
  say "$stack has no backup_function_name output yet (its snapshot function comes with this deploy), so there's nothing to snapshot with. Skipping."
  exit 0
fi
[[ -n $bucket ]] || die "$stack has a snapshot function but no backup_bucket output"

# Asynchronous, then watch the bucket: a synchronous invoke holds one idle connection for the whole
# Scan, which a runner's NAT drops after a few minutes. Keys are snapshots/pre-release/<UTC time>,
# so any key after the start time (less a minute for clock skew) is this run's. The function has no
# async retries, and the CLI none either, so a failure is one run.
prefix=snapshots/pre-release/
since=$prefix$(date -u -d '-60 seconds' +%Y-%m-%dT%H%M%SZ)
AWS_MAX_ATTEMPTS=1 aws lambda invoke --function-name "$fn" --invocation-type Event \
  --cli-binary-format raw-in-base64-out --payload '{"kind":"pre-release"}' /dev/null >/dev/null
say "started $fn for a pre-release snapshot; watching $bucket for it (up to 16 minutes)."

deadline=$((SECONDS + 16 * 60))
while ((SECONDS < deadline)); do
  sleep 15
  key=$(aws s3api list-objects-v2 --bucket "$bucket" --prefix "$prefix" --start-after "$since" --max-items 1 \
    --query 'Contents[0].Key' --output text)
  if [[ -n $key && $key != None ]]; then
    say "done: s3://$bucket/$key"
    exit 0
  fi
done
die "no new snapshot under s3://$bucket/$prefix after 16 minutes, so the release stops here. See $fn's CloudWatch logs (/aws/lambda/$fn)."
