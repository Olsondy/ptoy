#!/usr/bin/env bash
# HK update: pull main, build, publish the web build and characters, restart both services.
# Restarting the agent waits for active calls to end (TimeoutStopSec=infinity in its unit).
# Wrapped in main() so bash parses it all before `git reset` rewrites this file.
set -Eeuo pipefail

main() {
  local src=/opt/ptoy/source
  export PATH=/usr/local/bin:/usr/bin:/bin
  exec 9>/run/ptoy-update.lock
  flock -n 9 || { echo 'another update is running' >&2; exit 1; }

  cd "$src"
  git fetch --quiet origin main
  git reset --hard origin/main
  git log --oneline -1

  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm --filter @ptoy/web build

  rsync -a --delete apps/web/dist/ /var/www/ptoy/current/
  rsync -a --delete --chown=root:ptoy --chmod=D750,F640 \
    apps/agent/prompts/characters/ /var/lib/ptoy/resources/characters/

  echo 'restarting (waits for active calls to end)'
  systemctl restart ptoy-token ptoy-agent

  local i
  for i in $(seq 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8787/healthz && curl -fs -o /dev/null http://127.0.0.1:8081/; then
      echo 'deployed'
      return 0
    fi
    sleep 2
  done
  systemctl status ptoy-token ptoy-agent --no-pager -n 30 || true
  echo 'services not healthy after restart' >&2
  return 1
}

main "$@"
exit
