#!/usr/bin/env bash
# Deploy one stack ($1: staging or prod): `terraform apply` with the built Lambda zip, then upload the
# PWA bundle to the stack's bucket. `make deploy STACK=<stack>` runs it with the AWS credentials in
# the caller's environment: the stack's deploy role in CI, or the setup wizard's temporary ones.
# It never builds. `make build` (the deploy workflow's build job) makes backend/dist/lambda.zip and
# frontend/dist once, so staging and prod ship the same bytes.
# Writes url=https://<distribution domain> to .deploy/<stack>.env for the workflow.
set -euo pipefail

die() { echo "deploy: $*" >&2; exit 1; }

stack=${1:-}
repo=$(git rev-parse --show-toplevel)
root=$repo/infra/stacks/$stack
dist=$repo/frontend/dist
[[ -n $stack && -d $root ]] || die "usage: make deploy STACK=<$(ls "$repo/infra/stacks" | paste -sd '|')>"
[[ -f $repo/backend/dist/lambda.zip ]] || die "no backend/dist/lambda.zip: run make build first"
[[ -f $dist/index.html ]] || die "no frontend/dist/index.html: run make build first"
[[ -n ${TF_STATE_BUCKET:-} ]] || die "set TF_STATE_BUCKET to infra/bootstrap's state_bucket output"

# In CI the reviewer approved the environment, so apply without asking. By hand, Terraform asks.
approve=()
[[ -n ${CI:-} ]] && approve=(-auto-approve) && export TF_IN_AUTOMATION=1

tf() { terraform -chdir="$root" "$@"; }
tf init -input=false -reconfigure -backend-config="bucket=$TF_STATE_BUCKET"
tf apply -input=false "${approve[@]}"
bucket=$(tf output -raw pwa_bucket)
domain=$(tf output -raw distribution_domain)

content_type() {
  case $1 in
    *.html) echo "text/html; charset=utf-8" ;;
    *.js | *.mjs) echo "text/javascript; charset=utf-8" ;;
    *.css) echo "text/css; charset=utf-8" ;;
    *.json | *.map) echo "application/json" ;;
    *.webmanifest) echo "application/manifest+json" ;;
    *.txt) echo "text/plain; charset=utf-8" ;;
    *.svg) echo "image/svg+xml" ;;
    *.png) echo "image/png" ;;
    *.ico) echo "image/x-icon" ;;
    *.webp) echo "image/webp" ;;
    *.woff2) echo "font/woff2" ;;
    *.woff) echo "font/woff" ;;
    *) return 1 ;;
  esac
}

# Fail before uploading anything if the bundle holds a file type the deploy doesn't know.
while IFS= read -r -d '' f; do
  content_type "$f" >/dev/null || die "no Content-Type for ${f#"$dist"/}: add its extension to content_type"
done < <(find "$dist" -type f -print0)

# exts <dir> <find tests>...: the file extensions of the matching files under <dir>.
exts() {
  local dir=$1
  shift
  find "$dir" -type f "$@" | sed -n 's|.*/[^/]*\.\([A-Za-z0-9]*\)$|\1|p' | sort -u
}

# copy <dir under dist> <extension> <cache-control> <extra filters>...: upload that dir's files with
# that extension, so every file gets its own Content-Type.
copy() {
  local dir=$1 ext=$2 cache=$3
  shift 3
  aws s3 cp "$dist/$dir" "s3://$bucket/$dir" --recursive --only-show-errors \
    --exclude "*" --include "*.$ext" "$@" \
    --content-type "$(content_type "x.$ext")" --cache-control "$cache"
}

# Upload in an order that never leaves a client pointing at a missing file: the content-hashed
# assets first, then the other files, and index.html last. Old assets stay in the bucket, because a
# phone still running the previous release, or its service worker's precache, may ask for them.
# No CloudFront invalidation: every file outside assets/ is no-cache, so CloudFront revalidates it
# after the default behaviour's 1 s minimum TTL, and assets/ names change with their contents.
immutable="public, max-age=31536000, immutable"
if [[ -d $dist/assets ]]; then
  for ext in $(exts "$dist/assets"); do copy assets "$ext" "$immutable"; done
fi
for ext in $(exts "$dist" -not -path "$dist/assets/*" -not -path "$dist/index.html"); do
  copy "" "$ext" no-cache --exclude "assets/*" --exclude index.html
done
aws s3 cp "$dist/index.html" "s3://$bucket/index.html" --only-show-errors \
  --content-type "$(content_type index.html)" --cache-control no-cache

mkdir -p "$repo/.deploy"
echo "url=https://$domain" >"$repo/.deploy/$stack.env"
echo "deploy: $stack is live at https://$domain"
