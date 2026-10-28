# syntax=docker/dockerfile:1
# OpenBot's one container (ADR 0002): the server, every bot's screen and the bots' shell on one computer.
#   runtime  what users run: Debian, Node, Google Chrome, Xvfb, Openbox, tint2, Thunar, x11vnc + websockify, AT-SPI, cua-driver,
#            supervisord,
#            and the release it was built with (design §2.4)
#   dev      the same system plus the toolchain, without a release; docker/compose.dev.yml runs the bind-mounted repo
#            with hot reload
# Build from this folder (`docker build docker`); nothing from the repo is copied in but the release, which the runtime
# target takes as a build context: `docker build docker --target runtime --build-context release=<dir>`, where <dir>
# holds a release built by `pnpm release:package --out <dir>`.

# Debian trixie, pinned by digest: bumping it means updating both.
ARG DEBIAN_IMAGE=debian:trixie-20261020@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308

# cua-driver (MIT, https://github.com/trycua/cua) drives the desktop apps on bots' screens. A pinned release, checked
# against the SHA-256 recorded here and against its Sigstore signature, which must come from cua's release workflow at
# that exact tag. Bumping CUA_DRIVER_VERSION means updating both hashes from the release's SHA256SUMS. Only the binary
# reaches the runtime image; cosign (itself pinned by SHA-256) stays in this stage.
FROM ${DEBIAN_IMAGE} AS cua-driver

ARG TARGETARCH
ARG CUA_DRIVER_VERSION=0.38.0
ARG COSIGN_VERSION=3.1.3

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      amd64) label=linux-x86_64 \
             driver_sha256=31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd \
             cosign_sha256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ;; \
      arm64) label=linux-arm64 \
             driver_sha256=80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d \
             cosign_sha256=c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && cd /tmp \
 && curl -fsSL --retry 3 -o cosign "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${TARGETARCH}" \
 && echo "${cosign_sha256}  cosign" | sha256sum -c - \
 && chmod +x cosign \
 && tag="cua-driver-rs-v${CUA_DRIVER_VERSION}" \
 && tarball="cua-driver-rs-${CUA_DRIVER_VERSION}-${label}-binary.tar.gz" \
 && curl -fsSL --retry 3 -O "https://github.com/trycua/cua/releases/download/${tag}/${tarball}" \
 && curl -fsSL --retry 3 -O "https://github.com/trycua/cua/releases/download/${tag}/${tarball}.sigstore.json" \
 && echo "${driver_sha256}  ${tarball}" | sha256sum -c - \
 && ./cosign verify-blob --bundle "${tarball}.sigstore.json" \
      --certificate-identity "https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/${tag}" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "${tarball}" \
 && mkdir /out \
 && tar -xzf "${tarball}" -C /out --no-same-owner cua-driver

# Google Chrome comes from Google's apt repository, which publishes it for amd64 and arm64, signed with Google's Linux
# signing key. The key is checked here against the fingerprint recorded below; only the keyring reaches the runtime
# image. The repository keeps only the latest Chrome, so each build installs the stable release of the day.
FROM ${DEBIAN_IMAGE} AS chrome-key

ARG CHROME_KEY_FINGERPRINT=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gpg \
 && rm -rf /var/lib/apt/lists/*

RUN cd /tmp \
 && curl -fsSL --retry 3 -o key.asc https://dl.google.com/linux/linux_signing_key.pub \
 && test "$(gpg --show-keys --with-colons key.asc | awk -F: '$1 == "pub" { pub = 1; next } pub && $1 == "fpr" { print $10; pub = 0 }')" = "${CHROME_KEY_FINGERPRINT}" \
 && mkdir /out \
 && gpg --dearmor -o /out/google-chrome.gpg key.asc

FROM ${DEBIAN_IMAGE} AS base

ARG TARGETARCH
ARG NODE_VERSION=24.22.1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    TZ=UTC

# Google's repository is HTTPS-only, so the certificates come first. Chrome's package then replaces this source with
# its own, signed by the same keyring.
COPY --from=chrome-key /out/google-chrome.gpg /usr/share/keyrings/google-chrome.gpg
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && echo "deb [arch=${TARGETARCH} signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils openssl sudo procps less tzdata \
      supervisor \
      xvfb openbox x11vnc websockify xdotool x11-utils dbus-x11 \
      fonts-liberation fonts-noto-color-emoji \
      at-spi2-core mousepad \
      hsetroot tint2 thunar \
      google-chrome-stable \
 && google-chrome --version \
 && rm -rf /var/lib/apt/lists/*

# Desktop control (design §4): each screen runs its own cua-driver, which reads apps through AT-SPI (at-spi2-core) and
# acts on them. Mousepad is a small text editor bots can use, and the app the desktop's contract tests drive. Cua's
# product telemetry is off: nothing about bots' desktops leaves the computer.
COPY --from=cua-driver /out/cua-driver /usr/local/bin/cua-driver
ENV CUA_DRIVER_RS_TELEMETRY_ENABLED=0
RUN cua-driver --version
# Screens stop without warning (a restart, a crash), so Mousepad would greet every new screen with "restore the previous
# session?": it never restores one.
RUN printf "[org.xfce.mousepad.preferences.file]\nsession-restore='never'\n" > /usr/share/glib-2.0/schemas/90_openbot.gschema.override \
 && "$(find /usr/lib -type f -name glib-compile-schemas | head -n 1)" /usr/share/glib-2.0/schemas

# Bots' desktop (design §4): a wallpaper (blue mountains) and tint2's dock with Files (Thunar), Chrome and Mousepad. The dock draws over a
# copy of the wallpaper: Xvfb shows no compositor's work in its framebuffer, so a dock needing one (Plank) shows black.
# Chrome, however it's opened (the browser tools, the dock, a link), runs through openbot-browser with the bot's profile
# and DevTools, under both of its desktop file names; links open in it and folders in Thunar.
COPY desktop/tint2rc /etc/openbot/dock.tint2rc
COPY desktop/wallpaper.png /usr/share/openbot/wallpaper.png
COPY desktop/google-chrome.desktop /usr/local/share/applications/google-chrome.desktop
COPY desktop/google-chrome.desktop /usr/local/share/applications/com.google.Chrome.desktop
COPY desktop/mimeapps.list /etc/xdg/mimeapps.list
COPY openbot-browser.sh /usr/local/bin/openbot-browser

# Node from nodejs.org, checked against its published SHA-256.
RUN case "${TARGETARCH}" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac \
 && tarball="node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
 && cd /tmp \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${tarball}\$" | sha256sum -c - \
 && tar -xJf "${tarball}" -C /usr/local --strip-components=1 --no-same-owner \
 && rm "${tarball}" \
 && node --version

# Two users (design §2.1): `openbot-server` runs the server and owns the data dir; `openbot` is the bots' user, with
# passwordless sudo because it is their computer. The server may start processes as `openbot` (bots' shell and files).
RUN groupadd --gid 2000 openbot \
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
COPY desktopd.conf /etc/supervisor/conf.d/desktopd.conf
COPY start-desktopd.sh /usr/local/bin/openbot-desktopd
COPY install-release.sh /usr/local/bin/openbot-install-release
RUN mkdir -p /etc/openbot/entrypoint.d

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s \
  CMD curl -fsS "http://127.0.0.1:${OPENBOT_PORT}/api/health" > /dev/null || exit 1

ENTRYPOINT ["openbot-entrypoint"]
CMD ["supervisord", "--nodaemon", "--configuration", "/etc/supervisor/supervisord.conf"]

# What users run, with the release it was built with: `release` is the build context holding that release's archive,
# release.json and SHA256SUMS (`--build-context release=<dir>`), so this target can't be built without one. The release
# is installed into $OPENBOT_APP_DIR (the openbot-app volume) on start, so a fresh install starts without downloading
# code (docker/install-release.sh).
FROM base AS runtime
COPY --from=release / /usr/local/share/openbot/release/
RUN test -f /usr/local/share/openbot/release/release.json

FROM base AS dev

ARG PNPM_VERSION=12.6.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 git util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "pnpm@${PNPM_VERSION}" \
 && rm -rf /root/.npm

COPY dev/openbot.conf /etc/supervisor/conf.d/openbot.conf
COPY dev/setup.sh /etc/openbot/entrypoint.d/dev.sh
COPY dev/start-server.sh /usr/local/bin/openbot-server
COPY dev/start-desktopd.sh /usr/local/bin/openbot-desktopd

# The repo is bind-mounted here; its node_modules folders are named volumes, with pnpm's store inside the root one so
# installs can hard-link.
ENV OPENBOT_DEV=1 \
    npm_config_store_dir=/opt/openbot/current/node_modules/.pnpm-store
WORKDIR /opt/openbot/current
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --start-interval=2s \
  CMD curl -fsS "http://127.0.0.1:${OPENBOT_PORT}/api/health" > /dev/null || exit 1
