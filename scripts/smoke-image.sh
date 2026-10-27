#!/usr/bin/env bash
# Smoke-tests a runtime image: starts a container from it with no volumes, as a fresh install would, waits for Docker's
# health check, and checks that the server runs the release embedded in the image and that the screen daemon is up.
#   scripts/smoke-image.sh <image> <version>
set -euo pipefail

image="$1"
version="$2"
name="openbot-smoke-$$"
cleanup() { docker rm --force "${name}" > /dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --detach --name "${name}" --shm-size 1g "${image}" > /dev/null
status=
for _ in $(seq 90); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "${name}")"
  [[ "${status}" == healthy || "${status}" == unhealthy ]] && break
  [[ "$(docker inspect --format '{{.State.Running}}' "${name}")" == true ]] || { status=exited; break; }
  sleep 2
done
health="$(docker exec "${name}" curl -fsS http://127.0.0.1:3000/api/health || true)"
if [[ "${status}" != healthy || "${health}" != *"\"version\":\"${version}\""* ]]; then
  echo "smoke: the container isn't healthy on release ${version} (${status}): ${health:-no answer}" >&2
  docker logs "${name}" >&2
  exit 1
fi
docker exec "${name}" test -S /run/openbot/desktopd.sock || { echo "smoke: the screen daemon isn't up" >&2; docker logs "${name}" >&2; exit 1; }
echo "smoke: ${image} runs its embedded release ${version}"
