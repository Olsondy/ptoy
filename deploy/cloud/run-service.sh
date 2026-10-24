#!/usr/bin/env bash
# ptoy-managed: cloud-v1
set -Eeuo pipefail
case ${1:-} in
  livekit) exec "$LIVEKIT_BIN" --config /etc/ptoy/livekit.yaml ;;
  token) cd /opt/ptoy/current/apps/agent; exec "$NODE_BIN" node_modules/tsx/dist/cli.mjs src/token-server.ts ;;
  agent) cd /opt/ptoy/current/apps/agent; exec "$NODE_BIN" node_modules/tsx/dist/cli.mjs src/agent.ts start ;;
  *) printf '%s\n' 'Invalid service name' >&2; exit 1 ;;
esac
