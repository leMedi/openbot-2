#!/usr/bin/env bash
# Starts the installed release: $OPENBOT_APP_DIR/current is a symlink to releases/<version>/, whose bin/start runs the
# server (the release pipeline builds that). Without a release, waits instead of letting supervisord retry forever.
set -euo pipefail

start="${OPENBOT_APP_DIR}/current/bin/start"
if [[ -x "${start}" ]]; then
  cd "${OPENBOT_APP_DIR}/current"
  exec "${start}"
fi
echo "openbot: no release installed (${start} not found); waiting" >&2
exec sleep infinity
