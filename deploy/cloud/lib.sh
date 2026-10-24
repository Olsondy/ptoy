#!/usr/bin/env bash
# Sourced by our deployment scripts, never by the application user.
set -Eeuo pipefail
umask 027
fail() { printf '%s\n' "$*" >&2; exit 1; }
require_root_ubuntu() {
  [[ $EUID -eq 0 ]] || fail 'Run this deployment command as root (sudo).'
  [[ -r /etc/os-release ]] || fail 'Cannot identify operating system.'
  # OS-provided shell fragment, not user input.
  . /etc/os-release
  [[ ${ID:-} == ubuntu ]] || fail 'These scripts target Ubuntu only.'
  [[ $(uname -m) == x86_64 || $(uname -m) == aarch64 ]] || fail 'Unsupported CPU architecture.'
  for command in systemctl runuser rsync flock realpath curl ss ip install find tailscale; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
  done
  [[ -d /run/systemd/system ]] || fail 'systemd must be the running service manager.'
}
reject_symlink() { [[ ! -L $1 ]] || fail "Refusing symlink at managed path: $1"; }
managed_paths() {
  local path
  for path in /opt/ptoy /opt/ptoy/releases /etc/ptoy /var/lib/ptoy /var/lib/ptoy/resources /var/www/ptoy /var/www/ptoy/releases /usr/local/lib/ptoy /var/cache/ptoy; do reject_symlink "$path"; done
}
env_value() {
  "$BOOTSTRAP_NODE" --input-type=module - "$SCRIPT_DIR/configure.mjs" "$ENV_FILE" "$1" <<'JS'
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const {parseEnv}=await import(pathToFileURL(process.argv[2]));
const value=parseEnv(readFileSync(process.argv[3],'utf8'))[process.argv[4]];
if (!value || /[\r\n]/.test(value)) process.exit(1);
process.stdout.write(value);
JS
}
load_runtime() {
  ENV_FILE=/etc/ptoy/app.env
  [[ -f $ENV_FILE ]] || fail 'Run install.sh first.'
  reject_symlink "$ENV_FILE"
  validate_runtime
}
validate_runtime() {
  NODE_BIN=$(env_value NODE_BIN)
  PNPM_BIN=$(env_value PNPM_BIN)
  LIVEKIT_BIN=$(env_value LIVEKIT_BIN)
  for runtime in "$NODE_BIN" "$PNPM_BIN" "$LIVEKIT_BIN"; do
    [[ $runtime == /* && -x $runtime ]] || fail 'Configured executable is unavailable.'
    [[ $runtime != /root/* && $runtime != /home/* ]] || fail 'systemd ProtectHome requires runtimes outside home directories; use root-managed system paths.'
    local resolved_runtime
    resolved_runtime=$(realpath -- "$runtime")
    [[ $resolved_runtime != /root/* && $resolved_runtime != /home/* ]] || fail 'Configured executable resolves into a home directory hidden by systemd ProtectHome.'
  done
  RUNTIME_PATH="$(dirname "$NODE_BIN"):$(dirname "$PNPM_BIN"):/usr/local/bin:/usr/bin:/bin"
  "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13)) process.exit(1)' || fail 'Node >=22.13 is required.'
  [[ $(env PATH="$RUNTIME_PATH" "$PNPM_BIN" --version) == 10.18.0 ]] || fail 'Install pnpm 10.18.0 before deploying.'
  local expected actual
  expected=$(env_value LIVEKIT_VERSION)
  actual=$("$LIVEKIT_BIN" --version 2>&1) || fail 'LiveKit executable did not report its version.'
  [[ $actual =~ (^|[^0-9])v?${expected//./\.}([^0-9.]|$) ]] || fail 'LiveKit installed version differs from the configured fixed version.'
}
ops() { "$NODE_BIN" "$SCRIPT_DIR/ops.mjs" "$1" "$ENV_FILE" "${2:-600}"; }
check_tailscale() {
  tailscale status --json | "$NODE_BIN" -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{if(JSON.parse(s).BackendState!=="Running")process.exit(1)}catch{process.exit(1)}})' || fail 'Tailscale is not logged in and running; configure it manually.'
  local model_host
  model_host=$(env_value MODEL_HOST)
  if tailscale ping --timeout=5s --c=1 "$model_host" >/dev/null 2>&1; then
    printf '%s\n' 'Tailscale model device is reachable; direct/relay quality still needs a real call test.'
  else
    printf '%s\n' 'Model device is currently unreachable; application can remain available with calling disabled.'
  fi
}
check_public_interface() {
  local public_ip
  public_ip=$(env_value PUBLIC_IPV4)
  if ! ip -j -4 addr show | "$NODE_BIN" -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const ips=JSON.parse(s).flatMap(i=>i.addr_info??[]).map(a=>a.local);process.exit(ips.includes(process.argv[1])?0:1)})' "$public_ip"; then
    printf '%s\n' 'Public IPv4 is not assigned to a local interface (possible cloud NAT). Verify Agent-to-LiveKit media/hairpin with a real call before opening access.'
  fi
}
lock_deployment() {
  exec 9>/run/lock/ptoy-deploy.lock
  flock -n 9 || fail 'Another ptoy deployment operation is running.'
}
