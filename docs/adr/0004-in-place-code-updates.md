# Code updates install in place from GitHub Releases

OpenBot ships as two things: a runtime image (OS, browser, tools), updated rarely with `docker compose pull`, and a release (the app code), built on every push to main and installed in place by the running server: download, verify, migrate, switch a symlink, restart only the server, roll back on a failed health check. We chose this over image-only updates because a container cannot replace its own image without the Docker socket (root on the host for anything inside, bots included), and because restarting only the server keeps every bot's screen running through an update.

## Consequences

- Each release declares the minimum runtime image it needs; the updater refuses releases the running image is too old for.
- Dev mode bind-mounts the repo in place of the release symlink and disables the updater.
