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

# header <name>: the last response's value for that header.
header() { sed -n "s/^$1: *//Ip" "$tmp/headers" | tr -d '\r' | tail -n1; }

# check [-c <cache-control part>]... [-X <method>] [-H <header>]... <path> <status> <content-type
# prefix> [body pattern]: request the path (GET unless -X) until the response has that status,
# Content-Type, X-Robots-Tag: noindex, every -c part in its Cache-Control and the body pattern.
check() {
  local caches=() req=() method=GET part got problems attempt
  while [[ $1 == -* ]]; do
    case $1 in
      -c) caches+=("$2") ;;
      -X) method=$2 ;;
      -H) req+=(-H "$2") ;;
    esac
    shift 2
  done
  local path=$1 status=$2 type=$3 pattern=${4:-} label=$1
  [[ $method == GET ]] || label="$method $path"
  for attempt in 1 2 3 4 5 6; do
    # curl writes 000 itself when it can't connect; empty files keep the checks below quiet.
    : >"$tmp/headers" && : >"$tmp/body"
    got=$(curl -sS --max-time 20 -X "$method" "${req[@]}" -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}' "$url$path") || true
    problems=()
    [[ $got == "$status" ]] || problems+=("status $got, want $status")
    header content-type | grep -qi "^$type" || problems+=("Content-Type '$(header content-type)', want $type")
    header x-robots-tag | grep -qi noindex || problems+=("X-Robots-Tag '$(header x-robots-tag)', want noindex")
    for part in "${caches[@]}"; do
      header cache-control | grep -qiF "$part" || problems+=("Cache-Control '$(header cache-control)', want $part")
    done
    [[ -z $pattern ]] || grep -qF "$pattern" "$tmp/body" || problems+=("body lacks $pattern")
    ((${#problems[@]})) || { echo "ok   $label ($got $(header content-type))"; return; }
    ((attempt == 6)) || sleep 10
  done
  printf 'FAIL %s: %s\n' "$label" "$(IFS=';'; echo "${problems[*]}")"
  failed=1
}

check /week 200 text/html
check -c no-cache /robots.txt 200 text/plain
check -c no-cache /sw.js 200 text/javascript
check -c no-cache /manifest.webmanifest 200 application/manifest+json
# A content-hashed bundle script, named by the index.html that check leaves in $tmp/body.
check -c no-cache /index.html 200 text/html
asset=$(grep -o '/assets/[^"]*\.js' "$tmp/body" | head -n1) || true
if [[ -n $asset ]]; then
  check -c max-age=31536000 -c immutable "$asset" 200 text/javascript
else
  echo "FAIL /index.html: names no /assets/ script"
  failed=1
fi
# The API's own 404 (FastAPI's JSON), not index.html: the SPA fallback is on the default behaviour only.
# CloudFront runs no viewer-response function on a 404, so its X-Robots-Tag comes from FastAPI.
check /api/does-not-exist 404 application/json '"detail"'
check /api/sync 200 application/json '"collection_version"'
# OAC signs a write to the function URL only with the body's SHA-256 in x-amz-content-sha256 (here the
# empty body's); without it the function URL answers 403. FastAPI's 405 shows the request got through.
empty_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
check -X POST -H "x-amz-content-sha256: $empty_sha256" /api/sync 405 application/json '"Method Not Allowed"'

exit "$failed"
