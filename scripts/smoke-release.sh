#!/usr/bin/env bash
# Smoke-tests a release archive on this Linux machine (Node 24): unpacks it, runs its bin/start with throwaway data on a
# local port, and checks that /api/health reports the version and that the app's page renders.
#   scripts/smoke-release.sh <archive> <version>
set -euo pipefail

archive="$1"
version="$2"
port="${OPENBOT_SMOKE_PORT:-3999}"
dir="$(mktemp -d)"
server=
cleanup() {
  [[ -n "${server}" ]] && kill "${server}" 2> /dev/null || true
  rm -rf "${dir}"
}
trap cleanup EXIT

mkdir "${dir}/release"
tar -xzf "${archive}" -C "${dir}/release"
OPENBOT_DATA_DIR="${dir}/data" OPENBOT_HOME="${dir}/home" OPENBOT_HOST=127.0.0.1 OPENBOT_PORT="${port}" \
  OPENBOT_DESKTOPD_SOCKET="${dir}/no-screens.sock" "${dir}/release/bin/start" > "${dir}/server.log" 2>&1 &
server=$!

health=
for _ in $(seq 60); do
  health="$(curl -fsS "http://127.0.0.1:${port}/api/health" 2> /dev/null)" && break
  kill -0 "${server}" 2> /dev/null || break
  sleep 1
done
if [[ "${health}" != *"\"version\":\"${version}\""* ]]; then
  echo "smoke: the release didn't report healthy as ${version}: ${health:-no answer}" >&2
  cat "${dir}/server.log" >&2
  exit 1
fi
page="$(curl -fsS "http://127.0.0.1:${port}/" || true)"
if [[ "${page}" != *"<html"* ]]; then
  echo "smoke: the app's page didn't render" >&2
  cat "${dir}/server.log" >&2
  exit 1
fi
echo "smoke: release ${version} is healthy and serves the app"
