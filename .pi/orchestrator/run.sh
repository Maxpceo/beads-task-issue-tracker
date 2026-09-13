#!/bin/bash
# run.sh <taskId> <role-md> <model> <prompt-file> [tools]
# Script spawn: identify → new-split → send (Enter = \n in the same send). No typed dispatch.
set -euo pipefail
TASK_ID="${1:?taskId}"
ROLE_MD="${2:?role markdown}"
MODEL="${3:?model}"
PROMPT_FILE="${4:?prompt file}"
TOOLS="${5:-read,bash,edit,write}"

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$ROOT/lib.sh"
orch_resolve_ns || exit 1
[ -n "${CALLER_SURFACE:-}" ] || { echo "✗ нет caller surface" >&2; exit 1; }
orch_prune_panes_env "$NS_DIR/panes.env"

if grep -q "^task-$TASK_ID=" "$NS_DIR/panes.env" 2>/dev/null; then
  echo "⚠ task-$TASK_ID уже в panes.env" >&2
  exit 1
fi

OUT=$("$CMUX" new-split right --surface "$CALLER_SURFACE" 2>/dev/null) || { echo "✗ cmux new-split failed" >&2; exit 1; }
SURF=$(printf '%s\n' "$OUT" | awk '{for(i=1;i<=NF;i++) if($i ~ /^surface:/) {print $i; exit}}')
if [ -z "$SURF" ]; then
  SURF=$(printf '%s\n' "$OUT" | awk '{print $2; exit}')
fi
if [ -z "$SURF" ]; then
  echo "✗ new-split не вернул surface: $OUT" >&2
  exit 1
fi

CMD="cd $(pwd) && ORCH_NS=$NS_DIR bash $ROOT/pi-role.sh $ROLE_MD $MODEL $PROMPT_FILE $TOOLS"
if ! "$CMUX" send --surface "$SURF" "${CMD}\n"; then
  orch_kill_pane "$SURF"
  echo "✗ send failed, pane killed" >&2
  exit 1
fi

touch "$NS_DIR/panes.env"
grep -q '^orchestrator=' "$NS_DIR/panes.env" 2>/dev/null || echo "orchestrator=$CALLER_SURFACE" >> "$NS_DIR/panes.env"
echo "task-$TASK_ID=$SURF" >> "$NS_DIR/panes.env"
echo "$SURF"
