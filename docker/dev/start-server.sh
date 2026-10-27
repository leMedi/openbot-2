#!/usr/bin/env bash
# Dev server: installs the repo's dependencies into the node_modules volumes (fast when nothing changed), then runs
# `pnpm dev`. Supervisord restarts it if it exits.
set -euo pipefail

# pnpm and turbo start each task in its own process group, out of supervisord's reach, so a stop or restart would
# leave Vite holding the port (or an install running). Each step runs in the background and a stop ends its whole
# tree here, deepest first.
child=
descendants() {
  local pid
  for pid in $(pgrep -P "$1"); do
    descendants "${pid}"
    echo "${pid}"
  done
}
alive() {
  local pid
  for pid in "$@"; do
    kill -0 "${pid}" 2> /dev/null && return 0
  done
  return 1
}
stop() {
  [[ -n "${child}" ]] || exit 0
  local pids=($(descendants "${child}") "${child}")
  kill -TERM "${pids[@]}" 2> /dev/null || true
  for _ in $(seq 50); do
    alive "${pids[@]}" || exit 0
    sleep 0.2
  done
  kill -KILL "${pids[@]}" 2> /dev/null || true
  exit 0
}
trap stop TERM INT
run() {
  "$@" &
  child=$!
  wait "${child}"
}

cd /opt/openbot/current
CI=true run pnpm install --frozen-lockfile
TURBO_TELEMETRY_DISABLED=1 run pnpm dev --ui=stream
