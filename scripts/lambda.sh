#!/usr/bin/env bash
# Build the Lambda zip into $1 (default backend/dist/lambda.zip): run.sh, the recipes package and its
# runtime dependencies as Linux arm64 wheels for the python3.14 runtime. The same commit gives the
# same bytes, so one build deploys to staging and then prod.
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
out=$(realpath -m "${1:-$repo/backend/dist/lambda.zip}")
python=$(<"$repo/backend/.python-version")
# The python3.x runtimes run on Amazon Linux 2023, whose glibc is 2.34.
platform=aarch64-manylinux_2_34
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cd "$repo/backend"
uv export --locked --quiet --no-dev --no-emit-project --no-header --output-file "$stage/requirements.txt"
# Wheels only, so nothing is compiled for this container's platform. jstyleson (recipe-scrapers,
# through extruct) publishes only a source distribution, but it's one pure-Python module.
uv pip install --quiet --no-config --target "$stage/package" --python-version "$python" \
  --python-platform "$platform" --only-binary :all: --no-binary jstyleson --no-compile \
  -r "$stage/requirements.txt"
# bin/ holds console scripts pointing at this container's Python, and .lock is uv's own.
rm -rf "$stage/package/bin" "$stage/package/.lock"
cp -r src/recipes "$stage/package/recipes"
install -m 755 lambda/run.sh "$stage/package/run.sh"

mkdir -p "$(dirname "$out")"
uv run --locked --quiet python - "$stage/package" "$out" <<'PY'
import sys
import zipfile
from pathlib import Path

src, out = Path(sys.argv[1]), Path(sys.argv[2])
files = sorted(
    p for p in src.rglob("*") if p.is_file() and "__pycache__" not in p.relative_to(src).parts
)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for path in files:
        # Fixed timestamps and modes, so the bytes depend only on the contents.
        info = zipfile.ZipInfo(path.relative_to(src).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
        info.external_attr = (0o100755 if path.stat().st_mode & 0o111 else 0o100644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(info, path.read_bytes(), compresslevel=9)
PY
echo "$out: $(du -h "$out" | cut -f1)"
