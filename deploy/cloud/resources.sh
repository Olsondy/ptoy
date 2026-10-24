#!/usr/bin/env bash
# Operator explicitly supplies private resources. No default points at repository character files.
set -Eeuo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/lib.sh"
[[ $# -ge 2 && $# -le 3 ]] || fail 'Usage: bash resources.sh <characters-directory> <fillers-directory> [bootstrap-node]'
BOOTSTRAP_NODE=${3:-$(command -v node || true)}
[[ -x $BOOTSTRAP_NODE ]] || fail 'Pass an executable bootstrap Node path.'
require_root_ubuntu
managed_paths
lock_deployment
load_runtime
characters=$(realpath -- "$1")
fillers=$(realpath -- "$2")
[[ -d $characters && -d $fillers ]] || fail 'Both resource directories must exist.'
[[ $characters != /var/lib/ptoy/resources* && $fillers != /var/lib/ptoy/resources* ]] || fail 'Source resources must be outside the managed destination.'
[[ -f $characters/_rules.md && -f $characters/$(env_value DEFAULT_CHARACTER).md ]] || fail 'Character directory must include _rules.md and the configured default character.'
[[ -z $(find "$characters" "$fillers" -type l -print -quit) ]] || fail 'Resource symlinks are not accepted.'
if [[ -L /opt/ptoy/current ]]; then
  systemctl is-active --quiet ptoy-token || fail 'Existing deployment must have a working Token service before resource changes.'
  ops maintenance-on >/dev/null
  ops wait-drain >/dev/null
  systemctl stop ptoy-agent
elif [[ -e /var/lib/ptoy/access.sqlite ]]; then
  fail 'Existing database without a current release requires manual inspection.'
fi
for path in /var/lib/ptoy/resources/characters /var/lib/ptoy/resources/fillers; do reject_symlink "$path"; install -d -m 0750 -o root -g ptoy "$path"; done
# --delete is confined to these fixed, checked destinations after all calls drained.
rsync -rlt --delete --include='*/' --include='*.md' --exclude='*' "$characters/" /var/lib/ptoy/resources/characters/
rsync -rlt --delete --include='*/' --include='*.json' --include='*.wav' --exclude='*' "$fillers/" /var/lib/ptoy/resources/fillers/
chown -R root:ptoy /var/lib/ptoy/resources
find /var/lib/ptoy/resources -type d -exec chmod 0750 {} +
find /var/lib/ptoy/resources -type f -exec chmod 0640 {} +
printf '%s\n' 'Resources deployed. Maintenance remains enabled; release.sh completes application startup.'
