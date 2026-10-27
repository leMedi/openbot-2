#!/usr/bin/env bash
# Installs OpenBot on a Linux host (design §2.5), served from the site URL (default_site_url below):
#   curl -fsSL <site URL>/install.sh | bash
#   curl -fsSL <site URL>/install.sh | bash -s -- --yes --dir /srv/openbot --port 3000
#
# It checks the host (Linux x86_64 or arm64, Docker, Compose v2; offers to install Docker with get.docker.com), asks for
# the install dir, port and an optional Tailscale auth key (or takes them as flags), downloads the latest release's
# compose.yml and writes an .env beside it with a generated secret key and the runtime image the release pins, starts
# OpenBot, waits until it's healthy and prints its URL.
#
# Re-running it in the same dir keeps the .env: the only line it ever changes there is OPENBOT_IMAGE, and only when you
# accept the runtime update it offers. It refreshes compose.yml from the latest release (keeping the old one as
# compose.yml.bak when it changed).
#
# Environment (all optional): OPENBOT_SITE_URL (where this script is served from), OPENBOT_RELEASES_URL (where releases
# are downloaded from: <url>/latest/download/<file>, or <url>/download/v<version>/<file> with --version),
# OPENBOT_GET_DOCKER_URL (Docker's install script), OPENBOT_HEALTH_TIMEOUT (seconds, 600) and
# OPENBOT_TAILSCALE_TIMEOUT (seconds, 90).
set -euo pipefail

# Set from release.env when a release is packaged (scripts/src/install-script.ts); OPENBOT_SITE_URL and
# OPENBOT_RELEASES_URL override them.
default_site_url=https://openbot.lemedi.dev
default_releases_url=https://github.com/leMedi/openbot-2/releases

usage() {
  cat << EOF
Installs OpenBot with Docker Compose.

Usage: curl -fsSL ${site_url}/install.sh | bash -s -- [options]

Options:
  -y, --yes                 Don't ask: take the defaults and the options given, install Docker if it's missing, and
                            accept a runtime update on a re-run. Without a terminal to ask on, the defaults and options
                            are taken too, but Docker isn't installed and the runtime image isn't changed.
  --dir <dir>               Install dir, holding compose.yml and .env (default: ~/openbot).
  --port <port>             Host port OpenBot listens on (default: 3000).
  --public-url <url>        The URL you open OpenBot at, used for links and sign-in redirects
                            (default: http://<this host's address>:<port>, or the tailnet URL with Tailscale).
  --tailscale-key <key>     Add the Tailscale sidecar, joining your tailnet with this auth key, to serve OpenBot over
                            HTTPS at https://<hostname>.<tailnet>.ts.net.
  --tailscale-hostname <n>  The sidecar's name on your tailnet (default: openbot).
  --version <version>       Install this release instead of the latest, e.g. 0.1.42.
  --image <image>           Run this runtime image instead of the one the release pins.
  -h, --help                Show this help.

Settings live in <dir>/.env; a re-run keeps it, so options that would change it are ignored then.
EOF
}

# ---- Output and prompts --------------------------------------------------------------------------------------------

say() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'openbot: warning: %s\n' "$*" >&2; }
die() {
  printf 'openbot: %s\n' "$*" >&2
  exit 1
}

# Prompts read the terminal, not stdin, which is this script when it's piped from curl.
can_ask() {
  [[ "${yes}" != true ]] && { : < /dev/tty; } 2> /dev/null
}

# ask <question> <default>: prints the answer, or the default without a terminal or with --yes.
ask() {
  local answer=
  if can_ask; then
    printf '%s [%s]: ' "$1" "$2" > /dev/tty
    IFS= read -r answer < /dev/tty || true
  fi
  printf '%s' "${answer:-$2}"
}

# ask_secret <question>: like ask, without echoing; empty by default.
ask_secret() {
  local answer=
  if can_ask; then
    printf '%s: ' "$1" > /dev/tty
    IFS= read -rs answer < /dev/tty || true
    printf '\n' > /dev/tty
  fi
  printf '%s' "${answer}"
}

# confirm <question> <y|n>: yes with --yes; no without a terminal, so nothing is installed or changed unasked.
confirm() {
  local answer
  if [[ "${yes}" == true ]]; then return 0; fi
  if ! can_ask; then return 1; fi
  local hint='[Y/n]'
  [[ "$2" == n ]] && hint='[y/N]'
  printf '%s %s ' "$1" "${hint}" > /dev/tty
  IFS= read -r answer < /dev/tty || true
  case "${answer:-$2}" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---- The host --------------------------------------------------------------------------------------------------------

check_platform() {
  [[ "$(uname -s)" == Linux ]] || die "OpenBot installs on Linux; this is $(uname -s)."
  case "$(uname -m)" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) die "OpenBot runs on x86_64 and arm64; this machine is $(uname -m)." ;;
  esac
  command -v curl > /dev/null || die "curl is needed."
  command -v sha256sum > /dev/null || die "sha256sum (coreutils) is needed."
}

# Runs a command as root: directly, or with sudo.
as_root() {
  if [[ "$(id -u)" == 0 ]]; then
    "$@"
  elif command -v sudo > /dev/null; then
    sudo "$@"
  else
    die "this needs root: run the installer as root or install sudo."
  fi
}

# Sets `docker` to how this user reaches the Docker daemon: docker, or sudo docker when the user isn't in the docker
# group (as right after get.docker.com installed it).
docker=(docker)
find_docker() {
  if ! command -v docker > /dev/null; then
    say "Docker isn't installed."
    confirm "Install Docker with ${get_docker_url}?" y \
      || die "OpenBot runs on Docker: install it (https://docs.docker.com/engine/install/), or run this with --yes to install it with ${get_docker_url}, and run this again."
    curl -fsSL "${get_docker_url}" -o "${work}/get-docker.sh" || die "couldn't download ${get_docker_url}."
    as_root sh "${work}/get-docker.sh"
    command -v docker > /dev/null || die "Docker still isn't installed."
  fi
  if docker info > /dev/null 2>&1; then
    docker=(docker)
  elif [[ "$(id -u)" != 0 ]] && command -v sudo > /dev/null && sudo docker info > /dev/null 2>&1; then
    say "Using sudo for Docker (add yourself to the docker group to avoid that)."
    docker=(sudo docker)
  else
    die "Docker is installed but its daemon isn't reachable: start it (e.g. sudo systemctl start docker) and run this again."
  fi
  local compose_version
  compose_version="$("${docker[@]}" compose version --short 2> /dev/null)" \
    || die "Docker Compose v2 is needed (the docker compose plugin): https://docs.docker.com/compose/install/linux/"
  [[ "${compose_version#v}" =~ ^([2-9]|[1-9][0-9])\. ]] || die "Docker Compose v2 or newer is needed; this is ${compose_version}."
}

compose() { (cd "${dir}" && "${docker[@]}" compose "$@"); }

# ---- The release -----------------------------------------------------------------------------------------------------

# Downloads the release's compose.yml and release.json into $work, checked against its SHA256SUMS.
download_release() {
  local base
  if [[ -n "${version}" ]]; then base="${releases_url}/download/v${version#v}"; else base="${releases_url}/latest/download"; fi
  say "Downloading ${version:+release ${version#v} }from ${base}"
  local file
  for file in SHA256SUMS release.json compose.yml; do
    curl -fsSL "${base}/${file}" -o "${work}/${file}" || die "couldn't download ${base}/${file}."
  done
  (cd "${work}" && grep -E '  (release\.json|compose\.yml)$' SHA256SUMS | sha256sum --check --quiet --strict) \
    || die "the release's files don't match its SHA256SUMS."
  release_version="$(json_field version)"
  release_image="$(json_field runtimeImage)"
  [[ -n "${release_version}" && -n "${release_image}" ]] || die "the release's release.json has no version or runtime image."
}

# The value of a top-level string field of release.json (pretty-printed, one field per line).
json_field() {
  sed -n "s/^  \"$1\": \"\\([^\"]*\\)\",\\{0,1\\}\$/\\1/p" "${work}/release.json" | head -n 1
}

# ---- Files in the install dir ----------------------------------------------------------------------------------------

# The value of KEY in the .env, if set.
env_value() {
  sed -n "s/^$1=//p" "${dir}/.env" | tail -n 1
}

# Puts `file` at `target`, keeping what was there as <target>.bak when it differs.
replace_file() {
  local file="$1" target="$2"
  if [[ -f "${target}" ]] && cmp -s "${file}" "${target}"; then return; fi
  if [[ -f "${target}" ]]; then
    cp -p "${target}" "${target}.bak"
    say "Updated $(basename "${target}") (the previous one is $(basename "${target}").bak)"
  fi
  cp "${file}" "${target}"
}

write_tailscale_files() {
  cat > "${work}/compose.tailscale.yml" << 'EOF'
# The Tailscale sidecar, added by the installer when given an auth key (COMPOSE_FILE in .env lists this file). It joins
# your tailnet as $OPENBOT_TAILSCALE_HOSTNAME and serves OpenBot over HTTPS at https://<hostname>.<tailnet>.ts.net,
# with a certificate from Tailscale (MagicDNS and HTTPS must be on for the tailnet). The auth key is only used to join;
# the node's state is kept in the tailscale-state volume.
services:
  tailscale:
    image: ${OPENBOT_TAILSCALE_IMAGE:-tailscale/tailscale:stable}
    restart: unless-stopped
    hostname: ${OPENBOT_TAILSCALE_HOSTNAME:-openbot}
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY:-}
      TS_HOSTNAME: ${OPENBOT_TAILSCALE_HOSTNAME:-openbot}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "true"
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - tailscale-state:/var/lib/tailscale
      - ./tailscale-serve.json:/config/serve.json:ro
    depends_on:
      - openbot

volumes:
  tailscale-state:
EOF
  # Tailscale fills in TS_CERT_DOMAIN, the node's tailnet name; screens' streams are WebSockets, which it proxies too.
  cat > "${work}/tailscale-serve.json" << 'EOF'
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": { "${TS_CERT_DOMAIN}:443": { "Handlers": { "/": { "Proxy": "http://openbot:3000" } } } }
}
EOF
  replace_file "${work}/compose.tailscale.yml" "${dir}/compose.tailscale.yml"
  replace_file "${work}/tailscale-serve.json" "${dir}/tailscale-serve.json"
}

# 32 random bytes, base64url, like the key the server generates itself when none is given.
generate_secret() {
  head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
}

host_address() {
  local address
  address="$(hostname -I 2> /dev/null | awk '{ print $1 }')" || true
  printf '%s' "${address:-localhost}"
}

write_env() {
  local secret="" secret_note=""
  # The volumes outlive the install dir: an existing data volume holds secrets encrypted with the previous install's
  # key, which a new one can't read. Leaving the key empty keeps the one the server generated there, if it did.
  if "${docker[@]}" volume inspect openbot_openbot-data > /dev/null 2>&1; then
    warn "found the data volume of an earlier install (openbot_openbot-data): not generating a new secret key, so the server keeps the one in that volume. If the earlier install's key was in its .env, put it in OPENBOT_SECRET_KEY."
    secret_note="# Empty: the server uses the key it generated in the data volume (an earlier install's)."
  else
    secret="$(generate_secret)"
    secret_note="# Encrypts the stored credentials. Losing it loses them; keep a copy somewhere safe."
  fi
  {
    printf '# OpenBot settings, written by the installer on %s. Re-running the installer keeps this file; the only line\n' "$(date -u +%Y-%m-%d)"
    printf '# it changes is OPENBOT_IMAGE, when you accept a runtime update. Apply changes with: docker compose up -d\n\n'
    printf '# The runtime image, pinned by the release this was installed from (%s).\n' "${release_version}"
    printf 'OPENBOT_IMAGE=%s\n' "${image}"
    printf 'OPENBOT_PORT=%s\n' "${port}"
    printf 'OPENBOT_PUBLIC_URL=%s\n' "${public_url}"
    printf '%s\n' "${secret_note}"
    printf 'OPENBOT_SECRET_KEY=%s\n' "${secret}"
    if [[ -n "${tailscale_key}" ]]; then
      printf '\n# The Tailscale sidecar (compose.tailscale.yml).\n'
      printf 'COMPOSE_FILE=compose.yml:compose.tailscale.yml\n'
      printf 'OPENBOT_TAILSCALE_HOSTNAME=%s\n' "${tailscale_hostname}"
      printf 'TS_AUTHKEY=%s\n' "${tailscale_key}"
    fi
  } > "${work}/.env"
  # Only this user may read it: it holds the secret key and the Tailscale auth key.
  install -m 0600 "${work}/.env" "${dir}/.env"
}

# set_env_value <key> <value>: changes that line of the .env and nothing else, keeping the file's owner and mode.
set_env_value() {
  local updated="${work}/.env.updated"
  awk -v key="$1" -v value="$2" 'index($0, key "=") == 1 { print key "=" value; next } { print }' "${dir}/.env" > "${updated}"
  cat "${updated}" > "${dir}/.env"
}

# The runtime revision, N in <repository>:r<N>, or nothing.
revision() {
  if [[ "$1" =~ :r([0-9]+)$ ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
}

# On a re-run: offers the release's runtime image when it's newer than the one in .env.
offer_runtime_update() {
  local current new_revision current_revision
  current="$(env_value OPENBOT_IMAGE)"
  if [[ -n "${image_flag}" ]]; then warn "--image is ignored on a re-run; edit OPENBOT_IMAGE in ${dir}/.env instead."; fi
  if [[ "${current}" == "${release_image}" ]]; then return; fi
  # An image of another repository was chosen on purpose (--image or by hand): it stays.
  if [[ -n "${current}" && "${current%:*}" != "${release_image%:*}" ]]; then
    say "Keeping ${current} (release ${release_version} pins ${release_image})."
    return
  fi
  new_revision="$(revision "${release_image}")"
  current_revision="$(revision "${current}")"
  if [[ -n "${new_revision}" && -n "${current_revision}" ]] && ((new_revision <= current_revision)); then
    return
  fi
  say "Release ${release_version} runs on ${release_image}; this install runs ${current:-no image}."
  if confirm "Update the runtime image to ${release_image}?" y; then
    set_env_value OPENBOT_IMAGE "${release_image}"
    say "OPENBOT_IMAGE is now ${release_image}"
  else
    say "Keeping ${current:-no image}."
  fi
}

# ---- Running it ------------------------------------------------------------------------------------------------------

# Waits for /api/health on the host port and prints the version it reports.
wait_for_health() {
  local port="$1" deadline=$((SECONDS + health_timeout)) health
  say "Waiting for OpenBot to be healthy (the first start installs the app and can take a few minutes)"
  while ((SECONDS < deadline)); do
    if health="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/health" 2> /dev/null)" \
      && [[ "${health}" == *'"status":"ok"'* ]]; then
      printf '%s' "${health}" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
      return 0
    fi
    # Stopped, or crash-looping under `restart: unless-stopped`.
    case "$(compose ps --all --format '{{.State}}' openbot 2> /dev/null)" in
      exited | restarting | dead) break ;;
    esac
    sleep 3
  done
  compose logs --tail 80 openbot >&2 || true
  die "OpenBot didn't become healthy on port ${port} within ${health_timeout}s; its logs are above (docker compose logs in ${dir})."
}

# The sidecar's name on the tailnet (e.g. openbot.tail1234.ts.net), once it has joined.
tailscale_name() {
  local deadline=$((SECONDS + tailscale_timeout)) name
  while ((SECONDS < deadline)); do
    name="$(compose exec -T tailscale tailscale status --json 2> /dev/null \
      | sed -n 's/^ *"DNSName": "\([^"]*\)".*/\1/p' | head -n 1)" || true
    if [[ -n "${name}" ]]; then
      printf '%s' "${name%.}"
      return 0
    fi
    sleep 3
  done
  return 1
}

main() {
  site_url="${OPENBOT_SITE_URL:-${default_site_url}}"
  releases_url="${OPENBOT_RELEASES_URL:-${default_releases_url}}"
  releases_url="${releases_url%/}"
  get_docker_url="${OPENBOT_GET_DOCKER_URL:-https://get.docker.com}"
  health_timeout="${OPENBOT_HEALTH_TIMEOUT:-600}"
  tailscale_timeout="${OPENBOT_TAILSCALE_TIMEOUT:-90}"

  yes=false
  local dir_flag="" port_flag="" public_url_flag="" tailscale_key_flag="" tailscale_hostname_flag=""
  image_flag=""
  version=""
  while (($# > 0)); do
    case "$1" in
      -y | --yes) yes=true ;;
      --dir | --port | --public-url | --tailscale-key | --tailscale-hostname | --version | --image)
        (($# >= 2)) || die "$1 needs a value."
        case "$1" in
          --dir) dir_flag="$2" ;;
          --port) port_flag="$2" ;;
          --public-url) public_url_flag="$2" ;;
          --tailscale-key) tailscale_key_flag="$2" ;;
          --tailscale-hostname) tailscale_hostname_flag="$2" ;;
          --version) version="$2" ;;
          --image) image_flag="$2" ;;
        esac
        shift
        ;;
      --dir=* | --port=* | --public-url=* | --tailscale-key=* | --tailscale-hostname=* | --version=* | --image=*)
        set -- "${1%%=*}" "${1#*=}" "${@:2}"
        continue
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *) die "unknown option $1 (see --help)." ;;
    esac
    shift
  done

  check_platform
  work="$(mktemp -d)"
  trap 'rm -rf "${work}"' EXIT
  # The release first: a bad --version or no network shows before anything is installed.
  download_release
  find_docker

  dir="${dir_flag:-${OPENBOT_DIR:-}}"
  [[ -n "${dir}" ]] || dir="$(ask "Install dir" "${HOME}/openbot")"
  dir="${dir/#\~/${HOME}}"
  mkdir -p "${dir}"
  dir="$(cd "${dir}" && pwd)"

  local fresh=true
  if [[ -f "${dir}/.env" ]]; then
    fresh=false
    say "Found an install in ${dir}: keeping its .env"
    local flag
    for flag in "${port_flag:+--port}" "${public_url_flag:+--public-url}" "${tailscale_key_flag:+--tailscale-key}" "${tailscale_hostname_flag:+--tailscale-hostname}"; do
      if [[ -n "${flag}" ]]; then warn "${flag} is ignored on a re-run; change ${dir}/.env instead."; fi
    done
    replace_file "${work}/compose.yml" "${dir}/compose.yml"
    if [[ "$(env_value COMPOSE_FILE)" == *compose.tailscale.yml* ]]; then write_tailscale_files; fi
    offer_runtime_update
    port="$(env_value OPENBOT_PORT)"
    port="${port:-3000}"
  else
    port="${port_flag:-$(ask "Port" 3000)}"
    if ! [[ "${port}" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
      die "the port must be a number from 1 to 65535: ${port}."
    fi
    tailscale_key="${tailscale_key_flag:-$(ask_secret "Tailscale auth key, to serve OpenBot on your tailnet over HTTPS (Enter to skip)")}"
    tailscale_hostname="${tailscale_hostname_flag:-openbot}"
    public_url="${public_url_flag:-http://$(host_address):${port}}"
    image="${image_flag:-${release_image}}"
    replace_file "${work}/compose.yml" "${dir}/compose.yml"
    if [[ -n "${tailscale_key}" ]]; then write_tailscale_files; fi
    write_env
    say "Wrote ${dir}/compose.yml and ${dir}/.env (release ${release_version}, ${image})"
  fi

  say "Starting OpenBot (docker compose up -d in ${dir}, which pulls the runtime image if it isn't here yet)"
  compose up --detach --remove-orphans
  local running
  running="$(wait_for_health "${port}")"

  local url
  url="$(env_value OPENBOT_PUBLIC_URL)"
  url="${url:-http://localhost:${port}}"
  if [[ "$(env_value COMPOSE_FILE)" == *compose.tailscale.yml* ]]; then
    local name
    if name="$(tailscale_name)"; then
      if [[ "${fresh}" == true && -z "${public_url_flag}" ]]; then
        set_env_value OPENBOT_PUBLIC_URL "https://${name}"
        compose up --detach
        running="$(wait_for_health "${port}")"
      fi
      url="https://${name}"
    else
      warn "the Tailscale sidecar hasn't joined your tailnet yet (docker compose logs tailscale in ${dir}). Once it has, OpenBot is at https://<hostname>.<tailnet>.ts.net; set OPENBOT_PUBLIC_URL in ${dir}/.env to that."
    fi
  fi

  printf '\nOpenBot %s is running.\n\n  Open %s\n' "${running}" "${url}" >&2
  if [[ "${url}" != "http://localhost:${port}" ]]; then printf '  or http://localhost:%s on this machine\n' "${port}" >&2; fi
  printf '\nSettings: %s/.env. Update or repair by running this again:\n  curl -fsSL %s/install.sh | bash\n' "${dir}" "${site_url}" >&2
}

main "$@"
