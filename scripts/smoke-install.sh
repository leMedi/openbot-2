#!/usr/bin/env bash
# Smoke-tests the installer on this Linux machine against a packaged release, as `curl … | bash` would run it: serves
# the release's files from a file:// URL laid out like GitHub's (latest/download/<file>), then
#   1. installs unattended (--yes with flags) and checks the .env and that OpenBot is healthy on the release,
#   2. re-runs it and checks the .env is untouched, then that a re-run with --yes moves an older runtime image to the
#      release's, changing only that line,
#   3. when `script` (util-linux) is there, removes everything and installs again answering the prompts on a terminal.
# The release's runtime image must be pullable or already present (CI builds it from the release first). Everything it
# creates (containers, volumes, files) is removed at the end.
#   scripts/smoke-install.sh <release dir>
set -euo pipefail

release="$(cd "$1" && pwd)"
port="${OPENBOT_SMOKE_PORT:-3100}"
field() { sed -n "s/^  \"$1\": \"\\([^\"]*\\)\",\\{0,1\\}\$/\\1/p" "${release}/release.json" | head -n 1; }
version="$(field version)"
image="$(field runtimeImage)"
work="$(mktemp -d)"
dir="${work}/openbot"
cleanup() {
  if [[ -f "${dir}/compose.yml" ]]; then (cd "${dir}" && docker compose down --volumes --remove-orphans > /dev/null 2>&1) || true; fi
  rm -rf "${work}"
}
trap cleanup EXIT

fail() {
  echo "smoke-install: $*" >&2
  if [[ -f "${dir}/compose.yml" ]]; then (cd "${dir}" && docker compose logs --no-color --tail 100 >&2) || true; fi
  exit 1
}

site="${work}/site"
mkdir -p "${site}/latest/download"
cp "${release}/release.json" "${release}/compose.yml" "${release}/SHA256SUMS" "${release}/install.sh" "${site}/latest/download/"
install_url="file://${site}/latest/download/install.sh"
export OPENBOT_RELEASES_URL="file://${site}" OPENBOT_SITE_URL="file://${site}/latest/download"

healthy() {
  local health
  health="$(curl -fsS "http://127.0.0.1:$1/api/health")" || fail "nothing answers on port $1"
  [[ "${health}" == *"\"version\":\"${version}\""* ]] || fail "port $1 runs ${health}, not release ${version}"
}

echo "smoke-install: 1. unattended install of ${version} (${image}) on port ${port}"
curl -fsSL "${install_url}" | bash -s -- --yes --dir "${dir}" --port "${port}"
healthy "${port}"
env_file="${dir}/.env"
[[ "$(stat -c %a "${env_file}")" == 600 ]] || fail ".env should be readable by its owner only"
grep -qx "OPENBOT_IMAGE=${image}" "${env_file}" || fail ".env doesn't pin ${image}"
grep -qx "OPENBOT_PORT=${port}" "${env_file}" || fail ".env doesn't set the port"
grep -qE '^OPENBOT_SECRET_KEY=[A-Za-z0-9_-]{43}$' "${env_file}" || fail ".env has no generated secret key"
grep -qE "^OPENBOT_PUBLIC_URL=http://[^/]+:${port}\$" "${env_file}" || fail ".env has no public URL on the port"
settings="$(sed -n 's/^\([A-Z_]*\)=.*/\1/p' "${env_file}" | sort | tr '\n' ' ')"
[[ "${settings}" == "OPENBOT_IMAGE OPENBOT_PORT OPENBOT_PUBLIC_URL OPENBOT_SECRET_KEY " ]] \
  || fail ".env should set only the image, port, public URL and secret key: ${settings}"
cmp -s "${release}/compose.yml" "${dir}/compose.yml" || fail "compose.yml isn't the release's"

echo "smoke-install: 2. re-run keeps the .env"
before="$(sha256sum < "${env_file}")"
curl -fsSL "${install_url}" | bash -s -- --yes --dir "${dir}" --port 9 2> "${work}/rerun.log" || { cat "${work}/rerun.log" >&2; fail "the re-run failed"; }
cat "${work}/rerun.log" >&2
[[ "$(sha256sum < "${env_file}")" == "${before}" ]] || fail "the re-run changed the .env"
grep -q -- '--port is ignored' "${work}/rerun.log" || fail "the re-run didn't say --port was ignored"
healthy "${port}"

echo "smoke-install: 2b. re-run offers the release's runtime image over an older one"
sed -i "s|^OPENBOT_IMAGE=.*|OPENBOT_IMAGE=${image%:*}:r0|" "${env_file}"
curl -fsSL "${install_url}" | bash -s -- --yes --dir "${dir}"
[[ "$(sha256sum < "${env_file}")" == "${before}" ]] || fail "the runtime update didn't put back exactly OPENBOT_IMAGE=${image}"
healthy "${port}"

if command -v script > /dev/null; then
  echo "smoke-install: 3. interactive install, piped from curl"
  (cd "${dir}" && docker compose down --volumes --remove-orphans)
  rm -rf "${dir}"
  # The answers: install dir and port. `script` gives the installer a terminal to read them from.
  printf '%s\n%s\n' "${dir}" "$((port + 1))" \
    | script --quiet --return --command "curl -fsSL '${install_url}' | bash" /dev/null \
    || fail "the interactive install failed"
  grep -qx "OPENBOT_PORT=$((port + 1))" "${dir}/.env" || fail "the interactive install didn't take the port answered"
  healthy "$((port + 1))"
fi
echo "smoke-install: the installer installs ${version} and keeps its settings on a re-run"
