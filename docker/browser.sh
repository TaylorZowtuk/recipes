#!/usr/bin/env bash
# The watched browser's side of scripts/browser.sh, baked into the toolchain image as watched-browser.
#   serve <url> <time limit> [<port>]: in the browser container, Chromium headed on Xvfb, shown through
#     x11vnc and noVNC (port 6080) behind a one-time password, with CDP on 127.0.0.1:9222 only. With a
#     port, the URL is local `make dev`: localhost:<port> forwards to Vite (web:5173) on the Compose
#     network.
#   step <CDP URL> <origin>: in a step container in the browser's network namespace, run the step
#     script on stdin against the first page at that origin.
set -euo pipefail

# forward <listen host> <listen port> <target host> <target port>: a TCP port forward, in the background.
forward() {
  node -e '
    const net = require("node:net");
    const [host, port, toHost, toPort] = process.argv.slice(1);
    net.createServer((c) => {
      const u = net.connect(Number(toPort), toHost);
      c.pipe(u).pipe(c);
      u.on("error", () => c.destroy());
      c.on("error", () => u.destroy());
    }).listen(Number(port), host);' "$@" &
}

serve() {
  local url=$1 limit=$2 port=${3:-}
  export DISPLAY=:99
  umask 077
  mkdir -p "$HOME/run"
  # VNC's own authentication uses only the first 8 characters. The password stays in this tmpfs;
  # scripts/browser.sh reads it with `docker exec` and prints it once.
  printf '%s\n' "$(tr -dc A-Za-z0-9 </dev/urandom | head -c 8)" >"$HOME/run/vnc-password"

  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
  for _ in {1..50}; do [[ -e /tmp/.X11-unix/X99 ]] && break; sleep 0.1; done
  x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -quiet \
    -passwdfile "$HOME/run/vnc-password" >"$HOME/run/x11vnc.log" 2>&1 &
  websockify --web /usr/share/novnc 6080 localhost:5900 >"$HOME/run/websockify.log" 2>&1 &
  # The page keeps http://localhost:<port> as its origin, which Google's sign-in allows.
  [[ -z $port ]] || forward 127.0.0.1 "$port" web 5173

  local chrome
  chrome=$(echo /ms-playwright/chromium-*/chrome-linux*/chrome) # chrome-linux64 or chrome-linux-arm64
  [[ -x $chrome ]] || { echo "No Chromium at $chrome" >&2; exit 1; }
  # Launched directly, not through Playwright, which adds --enable-automation (Google then refuses
  # sign-in). The sandbox works through the seccomp profile scripts/browser.sh passes.
  exec timeout "$limit" "$chrome" \
    --user-data-dir="$HOME/profile" \
    --remote-debugging-port=9222 \
    --no-first-run --no-default-browser-check --password-store=basic \
    --window-position=0,0 --window-size=1280,800 \
    "$url"
}

step() {
  local cdp=$1 origin=$2 file
  file=$(mktemp --suffix=.mjs)
  cat >"$file"
  exec node --input-type=module -e '
    import { chromium } from "/work/repo/frontend/node_modules/@playwright/test/index.mjs";
    const [cdp, origin, file] = process.argv.slice(1);
    const step = (await import(file)).default;
    const browser = await chromium.connectOverCDP(cdp);
    try {
      const context = browser.contexts()[0];
      // The human may have opened other tabs, or a sign-in popup: the app is the first page at its origin.
      const page = context.pages().find((p) => p.url() === origin || p.url().startsWith(`${origin}/`));
      if (!page) throw new Error(`No page at ${origin} in the watched browser: open it there again.`);
      await step({ browser, context, page, out: "/out" });
    } finally {
      await browser.close(); // Over CDP this only disconnects: the page stays open.
    }' "$cdp" "$origin" "$file"
}

case ${1:-} in
  serve | step) "$@" ;;
  *) echo "usage: watched-browser serve <url> <time limit> [<port>] | step <CDP URL> <origin>" >&2 && exit 1 ;;
esac
