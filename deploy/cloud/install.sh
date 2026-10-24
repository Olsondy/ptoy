#!/usr/bin/env bash
# Install only ptoy-owned directories and units. Does not start services or touch the web server.
set -Eeuo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/lib.sh"
[[ $# -ge 1 && $# -le 2 ]] || fail 'Usage: bash install.sh <settings.env> [bootstrap-node-absolute-path]'
BOOTSTRAP_NODE=${2:-$(command -v node || true)}
[[ -n $BOOTSTRAP_NODE && -x $BOOTSTRAP_NODE ]] || fail 'Node is required; pass its absolute executable path.'
require_root_ubuntu
managed_paths
lock_deployment
settings=$(realpath -- "$1")
[[ -f $settings ]] || fail 'Settings file not found.'
"$BOOTSTRAP_NODE" "$SCRIPT_DIR/configure.mjs" "$settings" /etc/ptoy --check
# Validate runtime paths before creating any user or configuration.
ENV_FILE=$settings
for name in NODE_BIN PNPM_BIN LIVEKIT_BIN; do
  runtime=$(env_value "$name")
  [[ -x $runtime ]] || fail "Configured $name is not executable. Install it manually first."
done
validate_runtime
if id ptoy >/dev/null 2>&1 && [[ ! -f /var/lib/ptoy/.cloud-managed ]]; then
  fail 'An existing ptoy user is not marked as managed by this installer; inspect manually.'
fi
for unit in ptoy-livekit ptoy-token ptoy-agent; do
  existing=$(systemctl show "$unit.service" --property=FragmentPath --value)
  if [[ -n $existing ]]; then
    [[ $existing == "/etc/systemd/system/$unit.service" && ! -L $existing ]] || fail "Refusing to replace an existing $unit service."
    cmp -s "$SCRIPT_DIR/systemd/$unit.service" "$existing" || fail "Existing $unit unit differs; drain and review its update manually."
  fi
done
if [[ -e /usr/local/lib/ptoy/run-service.sh ]]; then
  cmp -s "$SCRIPT_DIR/run-service.sh" /usr/local/lib/ptoy/run-service.sh || fail 'Existing service wrapper differs; review its update after draining.'
fi
if ! id ptoy >/dev/null 2>&1; then
  getent group ptoy >/dev/null && fail 'An unrelated ptoy group already exists.'
  useradd --system --user-group --home-dir /var/lib/ptoy --shell /usr/sbin/nologin ptoy
fi
install -d -m 0755 -o root -g root /opt/ptoy /opt/ptoy/releases /var/www/ptoy /var/www/ptoy/releases /usr/local/lib/ptoy
install -d -m 0750 -o root -g ptoy /etc/ptoy /var/lib/ptoy/resources
install -d -m 0700 -o ptoy -g ptoy /var/cache/ptoy
# /var/lib/ptoy is writable only by the service account; resources themselves are root-managed.
chown ptoy:ptoy /var/lib/ptoy
chmod 0750 /var/lib/ptoy
"$BOOTSTRAP_NODE" "$SCRIPT_DIR/configure.mjs" "$settings" /etc/ptoy
chown root:ptoy /etc/ptoy/app.env /etc/ptoy/livekit.yaml
chmod 0640 /etc/ptoy/app.env /etc/ptoy/livekit.yaml
load_runtime
for runtime in "$NODE_BIN" "$PNPM_BIN" "$LIVEKIT_BIN"; do
  runuser -u ptoy -- test -x "$runtime" || fail 'ptoy cannot execute a configured binary (check parent directory permissions).'
  [[ $runtime != /root/* && $runtime != /home/* ]] || fail 'systemd ProtectHome requires runtimes outside home directories; use root-managed system paths.'
done
for file in run-service.sh configure.mjs ops.mjs; do
  reject_symlink "/usr/local/lib/ptoy/$file"
  install -m 0755 -o root -g root "$SCRIPT_DIR/$file" "/usr/local/lib/ptoy/$file"
done
for unit in ptoy-livekit ptoy-token ptoy-agent; do
  install -m 0644 -o root -g root "$SCRIPT_DIR/systemd/$unit.service" "/etc/systemd/system/$unit.service"
done
printf '%s\n' 'ptoy-cloud-v1' > /var/lib/ptoy/.cloud-managed
chown root:root /var/lib/ptoy/.cloud-managed
chmod 0644 /var/lib/ptoy/.cloud-managed
systemctl daemon-reload
printf '%s\n' 'ptoy installed. No services started. Deploy resources, then run release.sh.'
