#!/usr/bin/env bash
# Tests the URL guard of `make browser` (scripts/browser.sh check <url> <staging's URL>), and that
# `start` runs it before any Docker call, run by `make check`. The staging and prod domains below are
# synthetic.
set -euo pipefail
cd "$(dirname "$0")/.."

staging=https://d111111abcdef8.cloudfront.net
prod=https://d222222abcdef8.cloudfront.net
failed=0 passed=0

result() {
  if [[ $2 == "$1" ]]; then
    passed=$((passed + 1))
  else
    shift 2
    echo "FAIL $*"
    failed=1
  fi
}

# expect accept|refuse <url> <staging's URL> [VAR=value]...: run the guard on the URL with only those
# variables of CI and STAGING_URL set. STAGING_URL in the environment must never count.
expect() {
  local want=$1 url=$2 stage=$3 got=refuse
  shift 3
  env -u CI -u STAGING_URL "$@" scripts/browser.sh check "$url" "$stage" >/dev/null 2>&1 && got=accept
  result "$want" "$got" "want $want, got $got: '$url' staging '$stage' $*"
}

expect accept http://localhost:5190 ''
expect accept http://localhost:5173/ ''
expect accept http://127.0.0.1:5190 ''
expect accept http://localhost:65535 ''
expect accept http://localhost:5190 '' CI=
expect accept "$staging" "$staging"
expect accept "$staging/" "$staging"
expect accept "$staging" "$staging/"

expect refuse http://localhost:5190 '' CI=1
expect refuse http://localhost:5190 '' CI=true
expect refuse "$staging" "$staging" CI=true
expect refuse "$staging" ''
expect refuse "$staging" '' STAGING_URL="$staging"
expect refuse "$prod" '' STAGING_URL="$prod"
expect refuse "$prod" "$staging"
expect refuse "$prod" "$staging" STAGING_URL="$prod"
expect refuse "$staging/week" "$staging"
expect refuse "http://${staging#https://}" "$staging"
expect refuse "$staging.example.com" "$staging"
expect refuse "" ""
# A malformed staging URL is refused even when URL is the same, so it never reaches the policy JSON.
for bad in "$staging/week" "$staging:443" https://D111111ABCDEF8.cloudfront.net \
  "http://${staging#https://}" "$staging\", \"*" "$staging\"" https://; do
  expect refuse "$bad" "$bad"
done
expect refuse https://example.com ''
expect refuse https://example.com/http://localhost:5190 ''
expect refuse http://example.com:5190 ''
expect refuse https://localhost:5190 ''
expect refuse http://localhost ''
expect refuse http://localhost:0 ''
expect refuse http://localhost:65536 ''
expect refuse http://localhost:5190/week ''
expect refuse http://localhost:5190@example.com ''
expect refuse http://localhost:5190.example.com ''
expect refuse http://localhost.example.com:5190 ''
expect refuse http://127x0x0x1:5190 ''
expect refuse http://0.0.0.0:5190 ''
expect refuse http://192.168.1.2:5190 ''
expect refuse "http://localhost:5190
https://example.com" ''
# The browser container's own ports: x11vnc, noVNC and CDP.
expect refuse http://localhost:5900 ''
expect refuse http://localhost:6080 ''
expect refuse http://127.0.0.1:9222 ''

# start refuses before any Docker call: docker and tar are stubs that record being run.
stub=$(mktemp -d)
trap 'rm -rf "$stub"' EXIT
for tool in docker tar; do
  printf '#!/bin/sh\necho "$0 $*" >>"%s/calls"\n' "$stub" >"$stub/$tool"
  chmod +x "$stub/$tool"
done
expect_start_refused() {
  local url=$1 stage=$2 code=0
  shift 2
  rm -f "$stub/calls"
  env -u CI -u STAGING_URL PATH="$stub:$PATH" COMPOSE_PROJECT_NAME=test HOST_UID=1000 HOST_GID=1000 \
    "$@" scripts/browser.sh start "$url" "$stage" >/dev/null 2>&1 || code=$?
  result refused "$( ((code)) && [[ ! -e $stub/calls ]] && echo refused || echo "exit $code, calls: $(cat "$stub/calls" 2>/dev/null)")" \
    "start '$url' staging '$stage' $*: want a refusal before any docker or tar call"
}
expect_start_refused https://example.com "$staging"
expect_start_refused "$prod" "$staging" STAGING_URL="$prod"
expect_start_refused http://localhost:5190 '' CI=1

echo "browser.test.sh: $passed passed"
exit "$failed"
