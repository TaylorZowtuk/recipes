# The toolchain image every `make` command runs in (see compose.yaml), and after it the watched
# browser's image, which only `make browser` builds.
# Dependabot bumps the pinned tags below. The build args come from the Makefile: Node's version
# from .nvmrc and Playwright's from frontend/pnpm-lock.yaml, so Dependabot leaves those two lines
# alone. Python's version comes from backend/.python-version (uv installs it on first use).
ARG NODE_VERSION
ARG PLAYWRIGHT_VERSION
FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM ghcr.io/astral-sh/uv:0.13.6 AS uv
# Terraform's one pin. The stacks' `required_version` must allow it.
FROM hashicorp/terraform:1.17.1 AS terraform
FROM lycheeverse/lychee:0.24.2 AS lychee
FROM ghcr.io/gitleaks/gitleaks:v8.30.1 AS gitleaks
FROM rhysd/actionlint:1.7.12 AS actionlint
FROM koalaman/shellcheck:v0.11.0 AS shellcheck
# The AWS CLI v2 bundle is self-contained, so it runs here as it does in its own image.
FROM amazon/aws-cli:2.39.1 AS awscli

# The browsers only work with their own Playwright release, so the tag follows the lockfile.
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS toolchain

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
COPY --from=actionlint /usr/local/bin/actionlint /usr/local/bin/
COPY --from=shellcheck /bin/shellcheck /usr/local/bin/
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws

# Containers run as the host user, whose UID the image doesn't know, so these are world-writable.
# Docker copies their mode into each new named volume mounted on them (compose.yaml).
RUN mkdir -p -m 1777 /work/home /work/cache /work/repo/frontend/node_modules /work/repo/backend/.venv
ENV HOME=/work/home \
    XDG_CACHE_HOME=/work/cache \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    pnpm_config_store_dir=/work/cache/pnpm-store \
    pnpm_config_confirm_modules_purge=false \
    UV_CACHE_DIR=/work/cache/uv \
    UV_PYTHON_INSTALL_DIR=/work/cache/python \
    UV_LINK_MODE=copy \
    NLTK_DATA=/work/cache/nltk_data \
    PYTHONDONTWRITEBYTECODE=1 \
    IN_CONTAINER=1
WORKDIR /work/repo

# The watched browser (`make browser`): the toolchain plus its display. The base image already has
# Xvfb; x11vnc serves it over VNC and noVNC (websockify) in a web page. CI never builds this stage.
FROM toolchain AS browser
RUN apt-get update \
 && apt-get install -y --no-install-recommends x11vnc novnc websockify \
 && rm -rf /var/lib/apt/lists/*
# Playwright's Chromium (Chrome for Testing) reads managed policies from here. `make browser` copies
# each run's policy in as root, so the browser's user can't change it.
RUN mkdir -p -m 755 /etc/opt/chrome_for_testing/policies/managed
COPY --chmod=755 browser.sh /usr/local/bin/watched-browser
