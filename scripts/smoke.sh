#!/usr/bin/env bash
# Smoke-check a deployed stack through CloudFront ($1: https://<distribution domain>). Run by the deploy
# workflow after each deploy and by the setup wizard, as `make smoke URL=<url>`. Each path is retried
# for a while, since a new distribution and a cold Lambda can take a moment to answer.
set -euo pipefail

url=${1%/}
[[ $url == https://* ]] || { echo "usage: make smoke URL=https://<distribution domain>" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failed=0

# check <path> <status> <content-type prefix> [body pattern]
check() {
  local path=$1 status=$2 type=$3 pattern=${4:-} got problems attempt
  for attempt in 1 2 3 4 5 6; do
    # curl writes 000 itself when it can't connect; empty files keep the checks below quiet.
    : >"$tmp/headers" && : >"$tmp/body"
    got=$(curl -sS --max-time 20 -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}' "$url$path") || true
    problems=()
    [[ $got == "$status" ]] || problems+=("status $got, want $status")
    header content-type | grep -qi "^$type" || problems+=("Content-Type '$(header content-type)', want $type")
    header x-robots-tag | grep -qi noindex || problems+=("X-Robots-Tag '$(header x-robots-tag)', want noindex")
    [[ -z $pattern ]] || grep -q "$pattern" "$tmp/body" || problems+=("body lacks $pattern")
    ((${#problems[@]})) || { echo "ok   $path ($got $(header content-type))"; return; }
    ((attempt == 6)) || sleep 10
  done
  printf 'FAIL %s: %s\n' "$path" "$(IFS=';'; echo "${problems[*]}")"
  failed=1
}

header() { sed -n "s/^$1: *//Ip" "$tmp/headers" | tr -d '\r' | tail -n1; }

check /week 200 text/html
check /robots.txt 200 text/plain
# The API's own 404 (FastAPI's JSON), not index.html: the SPA fallback is on the default behaviour only.
check /api/does-not-exist 404 application/json '"detail"'
check /api/sync 200 application/json '"collection_version"'

exit "$failed"
