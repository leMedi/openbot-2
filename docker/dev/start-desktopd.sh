#!/usr/bin/env bash
# Dev screen daemon: the bind-mounted repo's, restarted by Node when its code changes (which restarts the screens).
set -euo pipefail
cd /opt/openbot/current/apps/desktopd
exec node --watch src/main.ts
