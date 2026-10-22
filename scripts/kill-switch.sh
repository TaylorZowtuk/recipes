#!/usr/bin/env bash
# The kill switch by hand ($1: test or reset, $2: staging or prod), with the AWS credentials in the
# caller's environment, like scripts/deploy.sh: `make kill-switch-test STACK=<stack>` and
# `make kill-switch-reset STACK=<stack>`.
#   test:  publish to the stack's own kill-switch topic, wait until the API reserves 0, check
#          through CloudFront that the API is throttled and the PWA still serves, then reset.
#   reset: put the API's reserved concurrency back to the stack's configured value. Check the bill
#          first: the spend alarm trips the switch only when it moves into ALARM (infra/AGENTS.md).
# Names and the configured value come from the stack's Terraform outputs.
set -euo pipefail

die() { echo "kill-switch: $*" >&2; exit 1; }
say() { echo "kill-switch: $*"; }

action=${1:-}
stack=${2:-}
repo=$(git rev-parse --show-toplevel)
root=$repo/infra/stacks/$stack
[[ $action == test || $action == reset ]] || die "usage: scripts/kill-switch.sh <test|reset> <stack>"
[[ -n $stack && -d $root ]] || die "usage: make kill-switch-$action STACK=<$(ls "$repo/infra/stacks" | paste -sd '|')>"
[[ -n ${TF_STATE_BUCKET:-} ]] || die "set TF_STATE_BUCKET to infra/bootstrap's state_bucket output"

tf() { terraform -chdir="$root" "$@"; }
tf init -input=false -reconfigure -backend-config="bucket=$TF_STATE_BUCKET" >/dev/null
fn=$(tf output -raw api_function_name) || die "no api_function_name output: deploy $stack first"
want=$(tf output -raw api_reserved_concurrency)
topic=$(tf output -raw kill_switch_topic_arn)
domain=$(tf output -raw distribution_domain)
[[ $want =~ ^[0-9]+$ ]] || die "api_reserved_concurrency output isn't a number: $want"

# reserved: the API's reserved concurrency, or None when none is set.
reserved() {
  aws lambda get-function-concurrency --function-name "$fn" --query ReservedConcurrentExecutions --output text
}

reset() {
  aws lambda put-function-concurrency --function-name "$fn" --reserved-concurrent-executions "$want" >/dev/null
  local now
  now=$(reserved)
  [[ $now == "$want" ]] || die "$fn reserves $now after the reset, not $want"
  say "$fn reserves $want again: the API is back."
}

if [[ $action == reset ]]; then
  [[ $want != 0 ]] || die "$stack's configured api_reserved_concurrency is 0, so a reset would change nothing"
  say "$fn reserves $(reserved); resetting it to $want."
  reset
  exit 0
fi

# test. Refuse if the switch is already tripped: the reset at the end would undo a real trip.
before=$(reserved)
[[ $before != 0 ]] || die "$fn already reserves 0: the kill switch is tripped. Check the bill, then make kill-switch-reset STACK=$stack"
[[ $before == "$want" ]] || say "warning: $fn reserves $before, not the configured $want; the reset puts $want back."

# From here on, however the script ends, put the concurrency back if the test may have tripped it.
finished=
cleanup() {
  local status=$?
  if [[ -z $finished && $(reserved 2>/dev/null) == 0 ]]; then
    say "resetting after the failed test"
    reset || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
aws sns publish --topic-arn "$topic" --region "$(cut -d: -f4 <<<"$topic")" \
  --subject "Plateful $stack kill switch test" \
  --message "A test from scripts/kill-switch.sh: the kill switch should set $fn's reserved concurrency to 0." >/dev/null
say "published a test message to $topic; waiting for $fn to reserve 0."
# SNS invokes the kill switch asynchronously, and Lambda retries a failed attempt after about 1 and
# then 2 more minutes, so the wait covers both retries.
timeout=${KILL_SWITCH_TIMEOUT:-240}
for ((waited = 0; ; waited += 5)); do
  now=$(reserved)
  [[ $now == 0 ]] && break
  ((waited < timeout)) || die "$fn still reserves $now after ${timeout}s: the kill switch didn't trip (see its CloudWatch logs). A late retry may still trip it: if $fn later reserves 0, run make kill-switch-reset STACK=$stack or the Kill switch reset workflow."
  sleep 5
done
say "tripped after about ${waited}s: $fn reserves 0."

# status <path>: the HTTP status of a GET through the distribution (000 when curl can't connect).
status() { curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "https://$domain$1" || true; }
# A throttled function URL answers 429, which CloudFront passes on; any other error counts too.
for attempt in 1 2 3 4 5 6; do
  api=$(status /api/sync)
  [[ $api == 000 || $api == 2* ]] || break
  ((attempt < 6)) || die "https://$domain/api/sync still answers $api while $fn reserves 0"
  sleep 5
done
say "https://$domain/api/sync answers $api: the API is throttled."
pwa=$(status /)
[[ $pwa == 200 ]] || die "https://$domain/ answers $pwa while the switch is tripped, not 200: the PWA should still serve"
say "https://$domain/ answers 200: the PWA still serves."
reset
finished=1
say "the $stack kill switch works."
