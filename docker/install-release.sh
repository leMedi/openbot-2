#!/usr/bin/env bash
# Installs the release embedded in the runtime image (/usr/local/share/openbot/release: the archive, release.json and
# SHA256SUMS, as published) into $OPENBOT_APP_DIR, the openbot-app volume: unpacked into releases/<version>/ and made
# `current` when nothing is installed yet or what is installed is older. A newer release (installed by the updater)
# stays. Run as root by the entrypoint on every start; does nothing in an image without a release, such as dev's.
set -euo pipefail

embedded=/usr/local/share/openbot/release
[[ -f "${embedded}/release.json" ]] || exit 0

app="${OPENBOT_APP_DIR:?}"
field() { node -e 'process.stdout.write(String(require(process.argv[1])[process.argv[2]]))' "${embedded}/release.json" "$1"; }
version="$(field version)"
archive="$(field archive)"
target="${app}/releases/${version}"

if [[ ! -d "${target}" ]]; then
  echo "openbot: installing the embedded release ${version}" >&2
  (cd "${embedded}" && sha256sum --check --quiet --strict SHA256SUMS)
  install -d -o openbot-server -g openbot-server -m 0755 "${app}/releases"
  # What an interrupted install left behind.
  rm -rf "${app}/releases/.${version}."*
  # Unpacked beside its final place and moved in whole, so a stop half-way never leaves a partial release behind.
  partial="$(mktemp -d "${app}/releases/.${version}.XXXXXX")"
  tar -xzf "${embedded}/${archive}" -C "${partial}" --no-same-owner
  chown -R openbot-server:openbot-server "${partial}"
  chmod 0755 "${partial}"
  mv -T "${partial}" "${target}"
fi

# `current` is a symlink to releases/<version>; anything else there (dev's bind-mounted repo) is left alone.
current="${app}/current"
if [[ -e "${current}" && ! -L "${current}" ]]; then
  exit 0
fi
installed="$(basename "$(readlink "${current}" 2> /dev/null || true)")"
if [[ -z "${installed}" || ! -d "${app}/releases/${installed}" \
  || "$(printf '%s\n%s\n' "${installed}" "${version}" | sort -V | tail -n 1)" != "${installed}" ]]; then
  echo "openbot: release ${version} is current${installed:+ (was ${installed})}" >&2
  ln -sfn "releases/${version}" "${app}/.current"
  chown -h openbot-server:openbot-server "${app}/.current"
  mv -T "${app}/.current" "${current}"
fi
