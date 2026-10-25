#!/usr/bin/env bash
# The watched browser, on the host: `make browser URL=<url>` (start), `make browser-run < step.mjs`
# (run) and `make browser-stop` (stop) call it with the Makefile's COMPOSE_PROJECT_NAME, HOST_UID and
# HOST_GID, and start with staging's URL from .aws-setup.env as its second argument (never from the
# environment). The container side is docker/browser.sh. `check <url> <staging's URL>` is the URL
# guard alone, which scripts/browser.test.sh tests.
set -euo pipefail

die() { echo "$*" >&2 && exit 1; }

# check <url> <staging's URL>: refuse in CI, and print "local <port>" for local `make dev`, or
# "staging" for exactly staging's URL. Everything else, prod included, is refused.
check() {
  local url=${1%/} staging=${2%/}
  [[ -z ${CI:-} ]] || die "make browser never runs in CI."
  if [[ $url =~ ^http://(localhost|127\.0\.0\.1):([1-9][0-9]{0,4})$ ]] && ((BASH_REMATCH[2] <= 65535)); then
    case ${BASH_REMATCH[2]} in 5900 | 6080 | 9222)
      die "Port ${BASH_REMATCH[2]} is the watched browser's own (x11vnc, noVNC, CDP): use another DEV_PORT." ;;
    esac
    echo "local ${BASH_REMATCH[2]}"
  elif [[ $staging =~ ^https://[a-z0-9.-]+$ && $url == "$staging" ]]; then
    echo staging
  else
    die "make browser opens only http://localhost:<port>, http://127.0.0.1:<port> or exactly staging's" \
      "URL (STAGING_URL='…' in .aws-setup.env, which the setup wizard writes); refusing '$1'."
  fi
}

[[ ${1:-} == check ]] && { check "${2:-}" "${3:-}"; exit; }

project=${COMPOSE_PROJECT_NAME:?run through make}
name=$project-browser
image=$project-browser-image
# The browser container has no mounts, so its user only needs to be someone other than root (which
# HOST_UID is under rootless Docker): root would own, and so could edit, the URL policy.
uid=${HOST_UID:?run through make} gid=${HOST_GID:?run through make}
((uid)) || uid=65534 gid=65534

running() { docker container inspect "$name" >/dev/null 2>&1; }

start() {
  local url=${1%/} mode port='' network origin limit=${TIME_LIMIT:-2h} tmp vnc password='' own
  mode=$(check "$1" "$2")
  [[ $limit =~ ^[1-9][0-9]*[smh]?$ ]] || die "TIME_LIMIT is a duration such as 90m or 2h, not '$limit'."
  ! running || die "This worktree's watched browser is already running: make browser-stop first."
  # Until this run's container exists, a failure removes only the network (which fails harmlessly while
  # another run's browser uses it), never a browser that a concurrent start created.
  trap 'docker network rm "$name" >/dev/null 2>&1 || true' EXIT

  if [[ $mode == local* ]]; then
    # Vite (web:5173) is on the worktree's Compose network; the page stays http://localhost:<port>.
    port=${mode#local }
    origin=http://localhost:$port
    url=$origin
    network=${project}_default
    [[ -n $(docker compose ps --status running --quiet web 2>/dev/null) ]] ||
      die "Start \`make dev DEV_PORT=$port\` in this worktree first."
  else
    origin=$url
    network=$name
    docker network inspect "$network" >/dev/null 2>&1 || docker network create "$network" >/dev/null
  fi
  docker compose --progress quiet build browser

  # Docker's default seccomp profile plus a rule for Chromium's sandbox (see the ADR); refresh it when Docker's default changes.
  docker create --name "$name" --rm --init --network "$network" --label "plateful.origin=$origin" \
    --user "$uid:$gid" --cap-drop ALL --security-opt no-new-privileges \
    --security-opt "seccomp=$(dirname "$0")/../docker/browser-seccomp.json" \
    --shm-size 1g --tmpfs "/work/home:mode=700,uid=$uid,gid=$gid" \
    --publish 127.0.0.1::6080 \
    "$image" watched-browser serve "$url" "$limit" ${port:+"$port"} >/dev/null
  # From here on, a failure removes whatever this run created.
  trap stop EXIT

  # The run's URL policy, copied in as root before Chromium starts. It governs navigations (pages and
  # frames), so Google's sign-in and its button still load their subresources from *.gstatic.com.
  tmp=$(mktemp -d)
  printf '{"URLBlocklist": ["*"], "URLAllowlist": ["%s", "https://accounts.google.com"]}\n' \
    "$origin" >"$tmp/watched-browser.json"
  chmod 644 "$tmp/watched-browser.json"
  # GNU tar and bsdtar (macOS) spell a root-owned header differently.
  if tar --version 2>/dev/null | grep -q 'GNU tar'; then own=(--owner=0 --group=0); else own=(--uid 0 --gid 0); fi
  tar -C "$tmp" "${own[@]}" -cf - watched-browser.json |
    docker cp --quiet - "$name:/etc/opt/chrome_for_testing/policies/managed"
  rm -r "$tmp"
  docker start "$name" >/dev/null

  # Ready once the password is written and CDP and noVNC answer inside the container.
  for _ in {1..100}; do
    # --rm deletes a container that exits, so its logs are gone too.
    running || die "The watched browser exited during startup."
    password=$(docker exec "$name" cat /work/home/run/vnc-password 2>/dev/null) && [[ -n $password ]] &&
      docker exec "$name" node -e '
        Promise.all(["http://127.0.0.1:9222/json/version", "http://127.0.0.1:6080/vnc.html"].map((u) => fetch(u)))
          .then((rs) => process.exit(rs.every((r) => r.ok) ? 0 : 1), () => process.exit(1));' 2>/dev/null &&
      break
    password=''
    sleep 0.3
  done
  [[ -n $password ]] || { docker logs --tail 20 "$name" >&2 || true; die "The watched browser didn't start within 30 s: its last logs are above."; }
  vnc=$(docker port "$name" 6080/tcp)
  vnc=${vnc##*:}
  trap - EXIT
  cat <<EOF
The watched browser shows $url and stops itself after $limit (make browser-stop sooner).
For the human, in their own browser:
  http://127.0.0.1:$vnc/vnc.html?autoconnect=1&resize=scale
  Reach port $vnc on this machine with a VS Code forwarded port (Ports panel, then open the
  forwarded address with /vnc.html?autoconnect=1&resize=scale), or with
  ssh -L $vnc:127.0.0.1:$vnc $(hostname).
  One-time VNC password: $password
EOF
}

run() {
  local origin out=${OUT:-.screenshots/browser}
  running || die "No watched browser in this worktree: make browser URL=<url> first."
  docker volume inspect "${project}_node_modules" >/dev/null 2>&1 || die "Run make setup first."
  origin=$(docker inspect -f '{{index .Config.Labels "plateful.origin"}}' "$name")
  mkdir -p "$out"
  # In the browser's network namespace: CDP listens on its 127.0.0.1 only, so nothing else reaches it.
  docker run --rm -i --init --network "container:$name" \
    --user "$HOST_UID:$HOST_GID" --cap-drop ALL --security-opt no-new-privileges \
    --volume "${project}_node_modules:/work/repo/frontend/node_modules:ro" \
    --volume "$(cd "$out" && pwd):/out" \
    "$image" watched-browser step http://127.0.0.1:9222 "$origin"
}

stop() {
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}

case ${1:-} in
  start) start "${2:-}" "${3:-}" ;;
  run) run ;;
  stop) stop ;;
  *) die "usage: scripts/browser.sh check|start <url> <staging's URL> | run | stop" ;;
esac
