# Dev image setup, sourced by openbot-entrypoint (as root) before the data and home folders are set up.

# Gives `dir` (recursively) to openbot-server when its top is owned by someone else, e.g. after a uid change.
own_by_server() {
  if [[ "$(stat -c %u "$1")" != "$(id -u openbot-server)" ]]; then
    chown -R openbot-server:openbot-server "$1"
  fi
}

dev_setup() {
  local repo=/opt/openbot/current repo_uid package
  if [[ ! -f "${repo}/pnpm-workspace.yaml" ]]; then
    echo "openbot dev: the repo is not mounted at ${repo}; start with pnpm dev:up" >&2
    exit 1
  fi

  # On a Linux host the repo is owned by your uid; run the server as that uid so what it writes there (generated
  # routes, caches) stays yours. Docker Desktop shows bind mounts as root-owned and writable, so nothing changes there.
  repo_uid="$(stat -c %u "${repo}")"
  if [[ "${repo_uid}" != 0 && "${repo_uid}" != "$(id -u openbot-server)" ]]; then
    if [[ "${repo_uid}" == "$(id -u openbot)" ]]; then
      echo "openbot dev: the repo's owner uid ${repo_uid} is the bots' user; rebuild the image with other uids" >&2
      exit 1
    fi
    usermod --uid "${repo_uid}" openbot-server
    [[ -d "${OPENBOT_DATA_DIR}" ]] && own_by_server "${OPENBOT_DATA_DIR}"
  fi

  # Every workspace package's node_modules must be a volume: otherwise Linux binaries would land in the host's checkout.
  for package in "${repo}" "${repo}"/apps/* "${repo}"/packages/* "${repo}"/scripts "${repo}"/evals; do
    [[ -f "${package}/package.json" ]] || continue
    if ! mountpoint -q "${package}/node_modules"; then
      echo "openbot dev: ${package#"${repo}"/}/node_modules is not a volume; add it to docker/compose.dev.yml" >&2
      exit 1
    fi
    own_by_server "${package}/node_modules"
  done
}

dev_setup
