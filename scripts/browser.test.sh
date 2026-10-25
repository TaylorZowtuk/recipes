#!/usr/bin/env bash
# Tests the URL guard of `make browser` (scripts/browser.sh check <url>), run by `make check`. The
# staging and prod domains below are synthetic.
set -euo pipefail
cd "$(dirname "$0")/.."

staging=https://d111111abcdef8.cloudfront.net
prod=https://d222222abcdef8.cloudfront.net
failed=0 passed=0

# expect accept|refuse <url> [VAR=value]...: run the guard on the URL with only those variables of
# CI and STAGING_URL set.
expect() {
  local want=$1 url=$2 got=refuse
  shift 2
  env -u CI -u STAGING_URL "$@" scripts/browser.sh check "$url" >/dev/null 2>&1 && got=accept
  if [[ $got == "$want" ]]; then
    passed=$((passed + 1))
  else
    echo "FAIL want $want, got $got: '$url' $*"
    failed=1
  fi
}

expect accept http://localhost:5190
expect accept http://localhost:5173/
expect accept http://127.0.0.1:5190
expect accept http://localhost:5190 CI=
expect accept "$staging" STAGING_URL="$staging"
expect accept "$staging/" STAGING_URL="$staging"
expect accept "$staging" STAGING_URL="$staging/"

expect refuse http://localhost:5190 CI=1
expect refuse http://localhost:5190 CI=true
expect refuse "$staging" CI=true STAGING_URL="$staging"
expect refuse "$staging"
expect refuse "$staging" STAGING_URL=
expect refuse "$prod" STAGING_URL="$staging"
expect refuse "$staging/week" STAGING_URL="$staging"
expect refuse "http://${staging#https://}" STAGING_URL="$staging"
expect refuse "$staging.example.com" STAGING_URL="$staging"
expect refuse "" STAGING_URL=
expect refuse https://example.com
expect refuse http://example.com:5190
expect refuse https://localhost:5190
expect refuse http://localhost
expect refuse http://localhost:0
expect refuse http://localhost:65536
expect refuse http://localhost:5190/week
expect refuse http://localhost:5190@example.com
expect refuse http://localhost:5190.example.com
expect refuse http://localhost.example.com:5190
expect refuse http://0.0.0.0:5190
expect refuse http://192.168.1.2:5190
expect refuse "http://localhost:5190
https://example.com"

echo "browser.test.sh: $passed passed"
exit "$failed"
