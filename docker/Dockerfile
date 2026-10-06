# The toolchain image every `make` command runs in (see compose.yaml).
# Dependabot bumps the pinned tags below. Node's version comes from .nvmrc (the NODE_VERSION
# build arg) and Python's from backend/.python-version (uv installs it on first use).
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM ghcr.io/astral-sh/uv:0.12.23 AS uv
# Terraform's one pin. The stacks' `required_version` must allow it.
FROM hashicorp/terraform:1.16.4 AS terraform
FROM lycheeverse/lychee:0.24.2 AS lychee
FROM ghcr.io/gitleaks/gitleaks:v8.30.1 AS gitleaks

# Must match @playwright/test in frontend/pnpm-lock.yaml: scripts/check-playwright-image.sh checks.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends make && rm -rf /var/lib/apt/lists/*

# Node from .nvmrc replaces the image's own Node.
COPY --from=node /usr/local/bin/node /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable pnpm

COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=terraform /bin/terraform /usr/local/bin/
COPY --from=lychee /usr/local/bin/lychee /usr/local/bin/
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/

# Containers run as the host user, whose UID the image doesn't know, so these are world-writable.
# Docker copies their mode into each new named volume mounted on them.
#   /work/repo          the bind-mounted checkout
#   /work/node_modules  a volume. `make deps` installs the frontend from copies of its package.json
#                       and lockfile in /work. Node, Vite and tsc find it by walking up from
#                       /work/repo/frontend, so no node_modules directory lands in the checkout.
#   /work/venv          the backend's virtualenv, a volume
#   /work/terraform     each stack's .terraform data dir (providers), a volume
#   /work/cache         uv, Python, pnpm, corepack and pyright caches, a volume shared by every
#                       worktree. Each of those tools locks its cache against concurrent use.
RUN mkdir -p -m 1777 /work /work/repo /work/home /work/node_modules /work/venv /work/terraform /work/cache
ENV PATH=/work/node_modules/.bin:$PATH \
    HOME=/work/home \
    XDG_CACHE_HOME=/work/cache \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    pnpm_config_store_dir=/work/cache/pnpm-store \
    pnpm_config_verify_deps_before_run=false \
    VITE_CACHE_DIR=/work/node_modules/.vite \
    UV_PROJECT_ENVIRONMENT=/work/venv \
    UV_CACHE_DIR=/work/cache/uv \
    UV_PYTHON_INSTALL_DIR=/work/cache/python \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1 \
    IN_CONTAINER=1
WORKDIR /work/repo
