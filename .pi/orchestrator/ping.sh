#!/bin/bash
# ping.sh <taskId> [ok|error] [body]
set -euo pipefail
ID="${1:?taskId}"
KIND="${2:-ok}"
BODY="${3:-}"

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$ROOT/lib.sh"
if [ -z "${ORCH_NS:-}" ]; then
  orch_resolve_ns || exit 1
else
  NS_DIR="$ORCH_NS"
fi
PANES="$NS_DIR/panes.env"
[ -f "$PANES" ] || { echo "✗ нет $PANES" >&2; exit 1; }

ORCH=$(grep '^orchestrator=' "$PANES" | tail -1 | cut -d= -f2 || true)
NAME="${AGENT_NAME:-agent}"
if [ "$KIND" = "error" ]; then
  MSG="[PING-ERROR] ${NAME} · задача ${ID}: ${BODY:-ошибка}"
else
  MSG="[PING] ${NAME} · задача ${ID} завершена, смотри results/${ID}.md"
fi

if [ -n "$ORCH" ]; then
  "$CMUX" send --surface "$ORCH" "${MSG}\n" || true
  "$CMUX" notify --title "visible-dispatch ${ID}" --body "${BODY:-готова}" --surface "$ORCH" || true
  "$CMUX" trigger-flash --surface "$ORCH" || true
fi
echo "✓ ping $KIND → ${ORCH:-no-orchestrator-pane} ($MSG)"
