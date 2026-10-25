# Agents drive a watched Chromium over CDP, signed in only with a staging-only Google test account

Some manual checks need a person: sign-in is Google only, so no agent can act as an editor on staging without one. The human works remotely and the dev box is headless, so there is no screen to put a browser on. The watched browser gives them one. `make browser URL=<url>` starts Playwright's Chromium (Chrome for Testing), headed on Xvfb, in a container from the toolchain image, with x11vnc and noVNC installed in its Dockerfile, no third-party image. The human opens noVNC through a forwarded port, types a one-time password and signs in. Agents then drive the same page over the Chrome DevTools Protocol (CDP) with step scripts (`make browser-run < step.mjs`). Sign-in uses only a **dedicated Google test account**, on staging's editor allowlist and nowhere else.

## What is signed in is the control

The `tz` user is in the `docker` group, so every agent on the box is effectively root. No file mode, user or port binding can keep a signed-in browser away from another agent: it can `docker exec` into the container or read its tmpfs. So the real control is **what is signed in**: a throwaway Google account used for nothing else, never a household account, on staging's allowlist only. The worst another agent can do with it is edit staging.

Google's test users are per Cloud project, and both stacks' OAuth clients live in one project, so the test account is a test user for prod's client too. Prod's editor allowlist keeps it out of prod, and each stack's API accepts only ID tokens issued for its own client, so a staging token is no use on prod. The setup wizard's "Test account for the watched browser" stage adds the account to staging's allowlist and the project's test users, and writes staging's URL to the gitignored `.aws-setup.env`.

## Guards

- `make browser` refuses when `CI` is set, and opens only `http://localhost:<port>`, `http://127.0.0.1:<port>` (local `make dev` in the same worktree) or exactly staging's URL, read only from `STAGING_URL='…'` in the gitignored `.aws-setup.env`, never from the environment or the make command line. Everything else, prod included, is refused before any Docker call. Staging's domain stays out of the repo.
- CDP has no authentication and exposes every cookie, so it listens only on the browser container's own 127.0.0.1, never on its Docker network or a host port: on Linux the host can reach any port a container listens on at its network address, published or not. Step scripts run in a container that shares the browser's network namespace (`--network container:<browser>`). Only noVNC is published, on 127.0.0.1, behind a random password printed once.
- A managed Chromium policy, copied in as root before Chromium starts, blocks every URL (`URLBlocklist: *`) except the app's origin and `https://accounts.google.com`. It governs navigations (pages and frames) only, not subresource fetches: Google's sign-in still loads from `*.gstatic.com`, and a page could still fetch from other origins.
- The container has no mounts (no repo, `~/.aws`, `~/.Xauthority` or Docker socket), drops all capabilities, sets `no-new-privileges`, keeps the profile on a mode-700 tmpfs, is removed when it stops, and stops itself after a time limit (2 h by default).

## Chromium's sandbox

Chromium in Docker usually needs `--no-sandbox`. Here Docker's default seccomp profile, not AppArmor, is what breaks the sandbox: making AppArmor unconfined makes it worse, because this host sets `kernel.apparmor_restrict_unprivileged_userns`. So the container runs with a copy of Docker's default seccomp profile (moby/profiles seccomp v0.2.3, as in Docker 29.8) plus one rule, at the end, allowing `chroot`, `clone` and `unshare` (`docker/browser-seccomp.json`), and AppArmor stays on. Chromium then has its namespace and seccomp-BPF sandboxes. The trade-off: the container may create user namespaces, which is more kernel attack surface, in exchange for a sandboxed renderer on pages that load Google's scripts. The profile copy must be refreshed when Docker's default changes.

## Considered options

- **A headed browser on the human's X server over `ssh -X`.** Trusted X11 forwarding lets the remote side read the human's Windows clipboard and keystrokes, and the household accounts signed in there are editors on prod too.
- **A headless run with the service token.** No human ever signs in, so it can't test sign-in, and it needs a long-lived credential in a file on the box.
- **A DevTools screencast.** It exposes CDP to the human's browser, and typing into Google's sign-in through it isn't safe.

## Consequences

- The human must take part in every session that signs in: forward the port, type the password, sign in with the test account.
- A session's traffic counts against staging's WAF limit and the API's reserved concurrency like anyone else's.
- Chromium is launched directly, not through Playwright's `launch()`, which adds `--enable-automation`, a flag Google's sign-in refuses. This assumes Google accepts sign-in from Chrome for Testing otherwise. If it doesn't, the watched browser still serves local `make dev` and signed-out checks, and signing in on staging needs a new ADR.
