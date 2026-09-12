#!/bin/bash
# lib.sh — beads visible-dispatch helpers. Runtime ns lives under $HOME/.pi/orchestrator.
# Do not source Haasbot paths. Do not write Haasbot trees.

ORCH_ROOT="${ORCH_ROOT:-$HOME/.pi/orchestrator}"
if [ -n "${CMUX:-}" ]; then
  :
elif command -v cmux >/dev/null 2>&1; then
  CMUX="$(command -v cmux)"
else
  CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"
fi

orch_fail() {
  echo "✗ $*" >&2
  return 1
}

# orch_resolve_ns — one cmux identify --json. Sets WS_UUID, NS_DIR, creates tasks/results/hang/prompts.
orch_resolve_ns() {
  if [ ! -x "$CMUX" ] && ! command -v "$CMUX" >/dev/null 2>&1; then
    orch_fail "cmux binary not found ($CMUX)"
    return 1
  fi
  local json
  json=$("$CMUX" identify --json 2>/dev/null) || {
    orch_fail "cmux identify --json failed"
    return 1
  }
  WS_UUID=$(ORCH_IDENTIFY_JSON="$json" python3 -c '
import json, os, sys, re
raw = os.environ.get("ORCH_IDENTIFY_JSON") or ""
try:
    data = json.loads(raw)
except Exception:
    sys.exit(1)
caller = data.get("caller") or {}
ws = (
    (caller.get("workspace_ref") if isinstance(caller, dict) else None)
    or data.get("workspace")
    or data.get("workspaceId")
    or data.get("workspace_id")
    or data.get("workspaceUuid")
    or {}
)
if isinstance(ws, dict):
    uid = ws.get("id") or ws.get("uuid") or ws.get("workspaceId") or ws.get("workspace_ref") or ""
else:
    uid = ws or ""
uid = str(uid).strip()
uid = re.sub(r"[^A-Za-z0-9._-]+", "-", uid).strip("-")
print(uid if uid else "")
')
  [ -n "$WS_UUID" ] || { orch_fail "cmux identify did not return a workspace id"; return 1; }
  NS_DIR="$ORCH_ROOT/ns/$WS_UUID"
  mkdir -p "$NS_DIR/tasks" "$NS_DIR/results" "$NS_DIR/hang" "$NS_DIR/prompts"
  export ORCH_NS="$NS_DIR" ORCH_ROOT WS_UUID
  return 0
}

orch_prune_panes_env() {
  local file="${1:-$NS_DIR/panes.env}"
  [ -f "$file" ] || return 0
  local tmp="$file.tmp"
  : > "$tmp"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    local ref="${line#*=}"
    if "$CMUX" read-screen --surface "$ref" --lines 1 >/dev/null 2>&1; then
      printf '%s\n' "$line" >> "$tmp"
    else
      echo "⚠ реестр: $line — surface мёртв, строку удалил" >&2
    fi
  done < "$file"
  mv "$tmp" "$file"
}

orch_registry_file() {
  printf '%s\n' "$NS_DIR/dispatch-registry.json"
}

orch_kill_pane() {
  local surf="$1"
  [ -n "$surf" ] || return 0
  "$CMUX" close-surface --surface "$surf" >/dev/null 2>&1 || true
}
