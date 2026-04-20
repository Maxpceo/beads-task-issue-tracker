#!/bin/bash
#
# lib/subagent-detect.sh — Shared helper for consistent subagent context detection
#
# Usage:
#   source "$CLAUDE_PROJECT_DIR/.claude/hooks/lib/subagent-detect.sh"
#   INPUT='{"cwd":"...","session_id":"...","transcript_path":"...","tool_use_id":"..."}'
#   if is_subagent "$INPUT"; then
#     echo "subagent context"
#   fi
#   # Also sets $SUBAGENT_FILE if detected via transcript method.
#
# Detection methods (in order, first match wins):
#   1. CWD inside */.worktrees/*  → subagent (reliable, worktree-mode dispatch)
#   2. Transcript: agent transcript has TOOL_USE_ID match → subagent
#      Also sets global SUBAGENT_FILE for downstream use (e.g. subagent_type lookup)
#   3. Marker lock /tmp/claude-subagent-${SESSION_ID}.lock with TTL-guard:
#      - File exists AND mtime ≤ 30 min → subagent
#      - File exists BUT mtime > 30 min → stale, treat as orchestrator (and delete)
#
# Returns:
#   0  — subagent context
#   1  — orchestrator context
#

# TTL for marker lock in minutes (stale if older than this)
_SUBAGENT_MARKER_TTL_MINUTES=30

# Global set by method 2 when a transcript match is found
SUBAGENT_FILE=""

is_subagent() {
  local input="${1:-}"
  # Accept input from argument or stdin
  if [[ -z "$input" ]]; then
    input=$(cat)
  fi

  SUBAGENT_FILE=""

  local cwd
  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
  [[ -z "$cwd" ]] && cwd=$(pwd 2>/dev/null || echo "")

  # Method 1: CWD worktree detection
  if [[ "$cwd" == *"/.worktrees/"* ]]; then
    return 0
  fi

  # Method 2: Transcript-based detection
  local transcript_path tool_use_id
  transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  tool_use_id=$(printf '%s' "$input" | jq -r '.tool_use_id // empty' 2>/dev/null)

  if [[ -n "$transcript_path" && -n "$tool_use_id" ]]; then
    local session_dir subagents_dir
    session_dir="${transcript_path%.jsonl}"
    subagents_dir="$session_dir/subagents"
    if [[ -d "$subagents_dir" ]]; then
      local matching
      matching=$(grep -l "\"id\":\"$tool_use_id\"" "$subagents_dir"/agent-*.jsonl 2>/dev/null | head -1)
      if [[ -n "$matching" ]]; then
        SUBAGENT_FILE="$matching"
        return 0
      fi
    fi
  fi

  # Method 3: Marker lock with TTL-guard
  local session_id lock_file now file_mtime age_minutes
  session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
  [[ -z "$session_id" ]] && return 1

  lock_file="/tmp/claude-subagent-${session_id}.lock"
  [[ -f "$lock_file" ]] || return 1

  now=$(date +%s 2>/dev/null || echo 0)
  file_mtime=$(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0)
  age_minutes=$(( (now - file_mtime) / 60 ))

  if [[ "$age_minutes" -ge "$_SUBAGENT_MARKER_TTL_MINUTES" ]]; then
    # Stale marker — delete and treat as orchestrator
    rm -f "$lock_file" 2>/dev/null || true
    return 1
  fi

  return 0
}
