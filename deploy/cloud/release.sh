#!/usr/bin/env bash
# Build first; drain before changing either current symlink. Keep old code, never copy databases.
set -Eeuo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/lib.sh"
[[ $# -ge 2 && $# -le 4 ]] || fail 'Usage: bash release.sh <Linux-source-directory> <release-id> [bootstrap-node] [drain-timeout-seconds]'
BOOTSTRAP_NODE=${3:-$(command -v node || true)}
[[ -x $BOOTSTRAP_NODE ]] || fail 'Pass an executable bootstrap Node path.'
require_root_ubuntu
managed_paths
lock_deployment
load_runtime
check_tailscale
check_public_interface
source_dir=$(realpath -- "$1")
release_id=$2
drain_timeout=${4:-600}
[[ $release_id =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || fail 'release-id must be 1–64 letters, digits, underscores or hyphens.'
[[ $drain_timeout =~ ^[0-9]+$ && $drain_timeout -ge 1 && $drain_timeout -le 86400 ]] || fail 'Drain timeout must be 1–86400 seconds.'
[[ $source_dir != /opt/ptoy* && $source_dir != /var/www/ptoy* ]] || fail 'Use a separate source checkout, not a managed deployment directory.'
[[ -f $source_dir/package.json && -f $source_dir/pnpm-lock.yaml && -f $source_dir/apps/agent/src/token-server.ts ]] || fail 'Not a ptoy source checkout.'
[[ -f /var/lib/ptoy/resources/characters/_rules.md && -f /var/lib/ptoy/resources/characters/$(env_value DEFAULT_CHARACTER).md ]] || fail 'Deploy the private character resources explicitly with resources.sh first.'
target="/opt/ptoy/releases/$release_id"
web_target="/var/www/ptoy/releases/$release_id"
[[ ! -e $target && ! -L $target && ! -e $web_target && ! -L $web_target ]] || fail 'Release ID already exists; choose a new ID.'
for path in /opt/ptoy/current /var/www/ptoy/current; do
  [[ ! -e $path || -L $path ]] || fail "Refusing non-symlink current path: $path"
done
if [[ -L /opt/ptoy/current ]]; then
  old_target=$(realpath -- /opt/ptoy/current)
  [[ $old_target == /opt/ptoy/releases/* && -d $old_target ]] || fail 'Current release points outside the managed release directory.'
  systemctl is-active --quiet ptoy-token || fail 'Token service must be healthy to establish a safe drain; repair it before updating.'
else
  [[ ! -e /var/lib/ptoy/access.sqlite ]] || fail 'Existing database without a current release requires manual inspection.'
  # Never stop a service or listener that predates this first deployment.
  for unit in ptoy-token ptoy-agent ptoy-livekit; do
    ! systemctl is-active --quiet "$unit" || fail "Unexpected running $unit before first release."
  done
  for port in 7880 7881 8081 8787; do
    [[ -z $(ss -H -ltn "sport = :$port") ]] || fail "TCP $port is already in use; inspect manually."
  done
  [[ -z $(ss -H -lun 'sport = :7882') ]] || fail 'UDP 7882 is already in use; inspect manually.'
fi
install -d -m 0750 -o ptoy -g ptoy "$target"
rsync -a --safe-links \
  --exclude='.git/' --exclude='node_modules/' --exclude='dist/' --exclude='.env*' --exclude='*.env' --exclude='*.env.*' \
  --exclude='*.sqlite*' --exclude='.data/' --exclude='.scratch/' --exclude='.impeccable/' --exclude='.worktree/' \
  --exclude='test-results/' --exclude='playwright-report/' --exclude='coverage/' --exclude='logs/' --exclude='.run/' \
  --exclude='apps/agent/prompts/characters/' --exclude='assets/fillers/' --exclude='deploy/windows/config.ps1' \
  "$source_dir/" "$target/"
chown -R ptoy:ptoy "$target"
runuser -u ptoy -- env PATH="$RUNTIME_PATH" HOME=/var/lib/ptoy XDG_CACHE_HOME=/var/cache/ptoy \
  "$PNPM_BIN" --dir "$target" install --frozen-lockfile --prod=false
runuser -u ptoy -- env PATH="$RUNTIME_PATH" HOME=/var/lib/ptoy XDG_CACHE_HOME=/var/cache/ptoy \
  "$PNPM_BIN" --dir "$target" typecheck
runuser -u ptoy -- env PATH="$RUNTIME_PATH" HOME=/var/lib/ptoy XDG_CACHE_HOME=/var/cache/ptoy \
  "$PNPM_BIN" --dir "$target" --filter @ptoy/web build
runuser -u ptoy -- env PATH="$RUNTIME_PATH" HOME=/var/lib/ptoy XDG_CACHE_HOME=/var/cache/ptoy \
  "$NODE_BIN" "$target/deploy/cloud/check-native.mjs" "$target"
[[ -f $target/apps/web/dist/index.html ]] || fail 'Frontend build did not produce index.html.'
install -d -m 0755 -o root -g root "$web_target"
rsync -rlt "$target/apps/web/dist/" "$web_target/"
chown -R root:root "$web_target"
find "$web_target" -type d -exec chmod 0755 {} +
find "$web_target" -type f -exec chmod 0644 {} +
# Application code becomes read-only to the service account; mutable cache/data live elsewhere.
chown -R root:ptoy "$target"
chmod -R go-w "$target"
chmod 0750 "$target"
mutation_started=false
on_error() {
  local code=$?
  if [[ $mutation_started == true ]]; then
    ops maintenance-on >/dev/null 2>&1 || true
    printf '%s\n' 'Deployment failed; maintenance was retained. No automatic rollback or forced call termination was performed.' >&2
  fi
  exit "$code"
}
trap on_error ERR
if [[ -L /opt/ptoy/current ]]; then
  ops maintenance-on >/dev/null
  mutation_started=true
  ops wait-drain "$drain_timeout" >/dev/null
  # At zero active attempts all established pipeline cleanup has completed.
  systemctl stop ptoy-agent
  systemctl stop ptoy-token
else
  mutation_started=true
fi
# A unique temporary name avoids following or overwriting an unrelated symlink.
app_link="/opt/ptoy/.current-$release_id"
web_link="/var/www/ptoy/.current-$release_id"
[[ ! -e $app_link && ! -L $app_link && ! -e $web_link && ! -L $web_link ]] || fail 'Temporary release link already exists; inspect manually.'
ln -s "$target" "$app_link"
mv -T "$app_link" /opt/ptoy/current
ln -s "$web_target" "$web_link"
mv -T "$web_link" /var/www/ptoy/current
systemctl start ptoy-livekit
systemctl start ptoy-token
systemctl start ptoy-agent
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if systemctl is-active --quiet ptoy-livekit \
    && systemctl is-active --quiet ptoy-token \
    && systemctl is-active --quiet ptoy-agent \
    && curl --silent --fail --max-time 3 http://127.0.0.1:7880/ >/dev/null \
    && curl --silent --fail --max-time 3 http://127.0.0.1:8787/healthz >/dev/null \
    && curl --silent --fail --max-time 3 http://127.0.0.1:8081/ >/dev/null \
    && ops status >/dev/null; then ready=true; break; fi
  sleep 2
done
[[ $ready == true ]] || fail 'Application readiness timed out; inspect systemd journal for ptoy units.'
# SDK health on 8081 checks registration and an existing inference process.
# Binding loading is checked separately before drain; real VAD/media still needs a call test.
# Model offline is a normal state; the API keeps calling disabled until it recovers.
systemctl enable ptoy-livekit ptoy-token ptoy-agent >/dev/null
status=$(ops maintenance-off)
printf '%s\n' "$status" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const x=JSON.parse(s);if(x.maintenance)process.exit(1);if(!x.modelsReady)console.log("Application ready; models offline, calling remains unavailable until recovery.")})'
trap - ERR
printf '%s\n' 'Release is running. Configure/verify the selected HTTPS/WebSocket entry (existing web server or Caddy) and external media connectivity separately.'
