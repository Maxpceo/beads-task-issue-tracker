#!/bin/bash
# watchdog.sh <taskId> — one-shot capped read-screen into hang file. scheduler_create stays off.
set -euo pipefail
ID="${1:?taskId}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$ROOT/lib.sh"
if [ -z "${ORCH_NS:-}" ]; then
  orch_resolve_ns || exit 1
else
  NS_DIR="$ORCH_NS"
fi
mkdir -p "$NS_DIR/hang"
PANES="$NS_DIR/panes.env"
SURF=$(grep "^task-$ID=" "$PANES" 2>/dev/null | tail -1 | cut -d= -f2 || true)
OUT="$NS_DIR/hang/${ID}.txt"
{
  echo "taskId=$ID"
  echo "surface=${SURF:-missing}"
  echo "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -z "$SURF" ]; then
    echo "status=missing-pane"
  elif "$CMUX" read-screen --surface "$SURF" --lines 20 >"$OUT.screen" 2>/dev/null; then
    echo "status=alive"
    echo "--- screen ---"
    head -c 4000 "$OUT.screen"
    echo
  else
    echo "status=dead-or-unreadable"
  fi
} > "$OUT"
rm -f "$OUT.screen"
echo "$OUT"
