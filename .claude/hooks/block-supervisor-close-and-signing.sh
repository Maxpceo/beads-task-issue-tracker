#!/bin/bash
#
# PreToolUse:Bash — blocks supervisors from:
#   (a) running `bd close`  — closing a bead is orchestrator's job
#   (b) self-signing `CODE REVIEW: APPROVED`  — only code-reviewer agent may write it
#   (c) self-signing `ACCEPTANCE: PASSED`     — only orchestrator/user may write it
#
# Rationale: validate-*.sh hooks check the PRESENCE of these markers, not WHO wrote them.
# A rogue supervisor could self-sign all markers and close the bead. This hook closes
# that hole by blocking the write commands from subagent context in the first place.
#
# Detection of subagent context mirrors block-orchestrator-tools.sh:
#   1. CWD inside */Projects/worktrees/*  → subagent (external worktree layout)
#   2. Transcript has matching agent-*.jsonl for TOOL_USE_ID → subagent
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

# --- Detect subagent context -------------------------------------------------
IS_SUBAGENT="false"
SUBAGENT_FILE=""

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[[ -z "$CWD" ]] && CWD=$(pwd 2>/dev/null || echo "")
if [[ "$CWD" == *"/Projects/worktrees/"* ]]; then
  IS_SUBAGENT="true"
fi

if [[ "$IS_SUBAGENT" == "false" ]]; then
  TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
  TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null)
  if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -n "$TOOL_USE_ID" ]]; then
    SESSION_DIR="${TRANSCRIPT_PATH%.jsonl}"
    SUBAGENTS_DIR="$SESSION_DIR/subagents"
    if [[ -d "$SUBAGENTS_DIR" ]]; then
      MATCHING=$(grep -l "\"id\":\"$TOOL_USE_ID\"" "$SUBAGENTS_DIR"/agent-*.jsonl 2>/dev/null | head -1)
      if [[ -n "$MATCHING" ]]; then
        IS_SUBAGENT="true"
        SUBAGENT_FILE="$MATCHING"
      fi
    fi
  fi
fi

# Orchestrator → nothing to enforce here
[[ "$IS_SUBAGENT" == "false" ]] && exit 0

# --- Determine subagent type (for code-reviewer exception) -------------------
SUBAGENT_TYPE=""
if [[ -n "$SUBAGENT_FILE" ]]; then
  # Transcript records subagent_type in early entries; grep first occurrence.
  SUBAGENT_TYPE=$(grep -o '"subagent_type":"[^"]*"' "$SUBAGENT_FILE" 2>/dev/null \
    | head -1 | sed -E 's/.*"subagent_type":"([^"]*)".*/\1/')
fi

deny() {
  local reason="$1"
  # Escape double quotes for JSON safety.
  reason=${reason//\"/\\\"}
  cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"$reason"}}
EOF
  exit 0
}

# --- Rule 1: bd close forbidden ---------------------------------------------
if echo "$COMMAND" | grep -qE 'bd[[:space:]]+close'; then
  deny "Supervisors must not close beads. Orchestrator runs the review chain (simplify → code-review → acceptance) and closes afterwards. Mark status 'inreview' and report completion."
fi

# --- Rule 2: Status-based review chain — only orchestrator sets these ------
# Supervisors may set 'inreview' but NOT 'simplified', 'reviewed', or 'accepted'
if echo "$COMMAND" | grep -qE 'bd[[:space:]]+update.*--status[[:space:]]+(simplified|reviewed|accepted)'; then
  deny "Supervisors must not set status 'simplified', 'reviewed', or 'accepted'. These statuses are set by orchestrator during the review chain (simplify → code-review → acceptance). Your job ends at 'inreview'."
fi

# --- Rule 3: Legacy comment markers — safety net --------------------------
# Old-style comment markers are no longer used for workflow, but block anyway
if echo "$COMMAND" | grep -qE 'CODE REVIEW:[[:space:]]*APPROVED'; then
  if [[ "$SUBAGENT_TYPE" != "code-reviewer" ]]; then
    deny "Only the code-reviewer agent may write 'CODE REVIEW: APPROVED'. Use status-based workflow: orchestrator sets --status reviewed."
  fi
fi

if echo "$COMMAND" | grep -qE 'ACCEPTANCE:[[:space:]]*PASSED'; then
  deny "Supervisors must not write 'ACCEPTANCE: PASSED'. Use status-based workflow: orchestrator sets --status accepted."
fi

exit 0
