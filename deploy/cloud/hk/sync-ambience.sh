#!/usr/bin/env bash
# Run on the dev machine: convert an ambience source directory (services/ambience/convert.py, into a
# temp dir; the sources stay as they are), check the result with the agent's own loader, then mirror
# it to HK. The agent reads ambience per call, so no restart is needed.
#   bash deploy/cloud/hk/sync-ambience.sh [dir] [--check]
# dir defaults to .data/ambience; --check stops before uploading. HK_SSH overrides root@38.55.199.239.
set -Eeuo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
dir="$repo/.data/ambience"
check_only=false
for arg in "$@"; do
  case $arg in
    --check) check_only=true ;;
    *) dir=$arg ;;
  esac
done
dir=$(cd -- "$dir" && pwd)
host=${HK_SSH:-root@38.55.199.239}
remote=/var/lib/ptoy/resources/ambience

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
[[ -f $dir/manifest.json ]] && cp "$dir/manifest.json" "$staging/"
python3 "$repo/services/ambience/convert.py" "$dir" "$staging"

(cd "$repo/apps/agent" && AMBIENCE_CHECK_DIR="$staging" node node_modules/tsx/dist/cli.mjs --eval "
import { loadAmbience } from './src/ambience/manifest.ts';
try {
  const a = loadAmbience(process.env.AMBIENCE_CHECK_DIR);
  console.log('ok:', a.levels.map((l) => l.id + (l.loop ? '' : ' (silent)')).join(', '));
} catch (error) {
  console.error('check failed, nothing synced:', error.message);
  process.exit(1);
}
")
$check_only && exit 0

rsync -rtcv --delete --chown=root:ptoy --chmod=D750,F640 "$staging/" "$host:$remote/"
echo "synced to $host:$remote (takes effect on the next call)"
