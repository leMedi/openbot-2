#!/usr/bin/env bash
# A bot's Google Chrome, however it's opened: by the screen daemon for the browser tools, from the dock, or by an app
# opening a link. Its screen's environment names the bot's profile (OPENBOT_BROWSER_PROFILE) and whether Chrome's
# sandbox can run (OPENBOT_BROWSER_SANDBOX=0 when the host keeps user namespaces from containers); DevTools listen on
# 127.0.0.1:9222+N for display :N. Opened again while it runs, Chrome hands the URLs to the running one.
set -euo pipefail

display="${DISPLAY#*:}"
display="${display%%.*}"
flags=(
  "--user-data-dir=${OPENBOT_BROWSER_PROFILE:?the screen sets it to the bot browser profile}"
  --no-first-run
  --no-default-browser-check
  --password-store=basic
  --disable-dev-shm-usage
  # Opened again after a crash, it opens as it was, without asking to restore.
  --hide-crash-restore-bubble
  --remote-debugging-address=127.0.0.1
  "--remote-debugging-port=$((9222 + display))"
  --start-maximized
)
# Without user namespaces the container is the only boundary (ADR 0002); --test-type hides the warning bar.
if [[ "${OPENBOT_BROWSER_SANDBOX:-1}" == 0 ]]; then flags+=(--no-sandbox --test-type); fi
exec google-chrome "${flags[@]}" "$@"
