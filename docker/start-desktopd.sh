#!/usr/bin/env bash
# Starts the installed release's screen daemon ($OPENBOT_APP_DIR/current/apps/desktopd), which needs nothing but Node.
# Without a release, waits instead of letting supervisord retry forever.
set -euo pipefail

main="${OPENBOT_APP_DIR}/current/apps/desktopd/src/main.ts"
if [[ -f "${main}" ]]; then
  exec node "${main}"
fi
echo "openbot-desktopd: no release installed (${main} not found); waiting" >&2
exec sleep infinity
