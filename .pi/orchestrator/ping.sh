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
[ -n "$ORCH" ] || { echo "✗ в panes.env нет orchestrator=" >&2; exit 1; }
NAME="${AGENT_NAME:-agent}"
DIGEST_HINT="${DIGEST_FILE:-results/${ID}.digest}"
if [ "$KIND" = "error" ]; then
  MSG="[PING-ERROR] ${NAME} · задача ${ID}: ${BODY:-ошибка}"
else
  MSG="[PING] ${NAME} · задача ${ID} завершена taskId=${ID} digest=${DIGEST_HINT}"
fi

send_rc=0
"$CMUX" send --surface "$ORCH" "${MSG}\n" || send_rc=$?
"$CMUX" notify --title "visible-dispatch ${ID}" --body "${BODY:-готова}" --surface "$ORCH" || true
"$CMUX" trigger-flash --surface "$ORCH" || true
if [ "$send_rc" -ne 0 ]; then
  echo "✗ ping send failed ($send_rc) → $ORCH" >&2
  exit "$send_rc"
fi
echo "✓ ping $KIND → $ORCH ($MSG)"
