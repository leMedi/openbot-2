# syntax=docker/dockerfile:1
# OpenBot's one container (ADR 0002): the server, every bot's screen and the bots' shell on one computer.
#   runtime  what users run: Ubuntu, Node, Chromium, Xvfb, Openbox, x11vnc + websockify, supervisord
#   dev      runtime plus the toolchain; docker/compose.dev.yml runs the bind-mounted repo with hot reload
# Build from this folder (`docker build docker`); nothing from the repo is copied in.

ARG UBUNTU_VERSION=24.04

FROM ubuntu:${UBUNTU_VERSION} AS runtime

ARG TARGETARCH
ARG NODE_VERSION=24.22.1
# Chromium comes from Playwright: Ubuntu only ships it as a snap, and Playwright builds it for amd64 and arm64.
ARG PLAYWRIGHT_VERSION=1.64.1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    TZ=UTC

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils openssl sudo procps less tzdata \
      supervisor \
      xvfb openbox x11vnc websockify xdotool x11-utils dbus-x11 \
      fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Node from nodejs.org, checked against its published SHA-256.
RUN case "${TARGETARCH}" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac \
 && tarball="node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
 && cd /tmp \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${tarball}\$" | sha256sum -c - \
 && tar -xJf "${tarball}" -C /usr/local --strip-components=1 --no-same-owner \
 && rm "${tarball}" \
 && node --version

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/chromium
RUN npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium \
 && chrome="$(find /opt/chromium -type f -name chrome -perm -u+x | head -n 1)" \
 && test -n "${chrome}" \
 && ln -s "${chrome}" /usr/local/bin/chromium \
 && chromium --version \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

# Two users (design §2.1): `openbot-server` runs the server and owns the data dir; `openbot` is the bots' user, with
# passwordless sudo because it is their computer. The server may start processes as `openbot` (bots' shell and files).
RUN userdel --remove ubuntu 2>/dev/null || true \
 && groupadd --gid 2000 openbot \
 && useradd --uid 2000 --gid openbot --shell /bin/bash --home-dir /home/openbot --create-home openbot \
 && groupadd --gid 2001 openbot-server \
 && useradd --uid 2001 --gid openbot-server --shell /bin/bash --home-dir /home/openbot-server --create-home openbot-server \
 && echo 'openbot ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/openbot \
 && echo 'openbot-server ALL=(openbot) NOPASSWD: ALL' > /etc/sudoers.d/openbot-server \
 && chmod 0440 /etc/sudoers.d/*

# Paths and settings needed before the database opens (design §2.3). The secret key, when not given, is generated
# into the data dir by the server on first boot.
ENV OPENBOT_DATA_DIR=/var/lib/openbot \
    OPENBOT_HOME=/home/openbot \
    OPENBOT_APP_DIR=/opt/openbot \
    OPENBOT_HOST=0.0.0.0 \
    OPENBOT_PORT=3000

COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY openbot.conf /etc/supervisor/conf.d/openbot.conf
COPY entrypoint.sh /usr/local/bin/openbot-entrypoint
COPY start-server.sh /usr/local/bin/openbot-server
RUN mkdir -p /etc/openbot/entrypoint.d

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s \
  CMD curl -fsS "http://127.0.0.1:${OPENBOT_PORT}/api/health" > /dev/null || exit 1

ENTRYPOINT ["openbot-entrypoint"]
CMD ["supervisord", "--nodaemon", "--configuration", "/etc/supervisor/supervisord.conf"]

FROM runtime AS dev

ARG PNPM_VERSION=12.6.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 git util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "pnpm@${PNPM_VERSION}" \
 && rm -rf /root/.npm

COPY dev/openbot.conf /etc/supervisor/conf.d/openbot.conf
COPY dev/setup.sh /etc/openbot/entrypoint.d/dev.sh
COPY dev/start-server.sh /usr/local/bin/openbot-server

# The repo is bind-mounted here; its node_modules folders are named volumes, with pnpm's store inside the root one so
# installs can hard-link.
ENV OPENBOT_DEV=1 \
    npm_config_store_dir=/opt/openbot/current/node_modules/.pnpm-store
WORKDIR /opt/openbot/current
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --start-interval=2s \
  CMD curl -fsS "http://127.0.0.1:${OPENBOT_PORT}/api/health" > /dev/null || exit 1
