#!/bin/bash
#
# PreToolUse: Block orchestrator from implementation tools
#
# Orchestrators investigate and delegate - they don't implement.
# Exception: small changes (1 file, < 20 lines) can be made directly on feature branches.
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Always allow Task (delegation)
[[ "$TOOL_NAME" == "Task" ]] && exit 0

# Detect SUBAGENT context - subagents get full tool access
IS_SUBAGENT="false"

# Method 1: CWD-based detection (reliable)
# Worktrees live under ~/Projects/worktrees/<project>/<branch>/ (external layout).
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
if [[ -z "$CWD" ]]; then
  CWD=$(pwd 2>/dev/null || echo "")
fi
if [[ "$CWD" == *"/Projects/worktrees/"* ]]; then
  IS_SUBAGENT="true"
fi

# Method 2: Transcript-based detection (fallback)
if [[ "$IS_SUBAGENT" == "false" ]]; then
  TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
  TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null)

  if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -n "$TOOL_USE_ID" ]]; then
    SESSION_DIR="${TRANSCRIPT_PATH%.jsonl}"
    SUBAGENTS_DIR="$SESSION_DIR/subagents"

    if [[ -d "$SUBAGENTS_DIR" ]]; then
      MATCHING_SUBAGENT=$(grep -l "\"id\":\"$TOOL_USE_ID\"" "$SUBAGENTS_DIR"/agent-*.jsonl 2>/dev/null | head -1)
      [[ -n "$MATCHING_SUBAGENT" ]] && IS_SUBAGENT="true"
    fi
  fi
fi

[[ "$IS_SUBAGENT" == "true" ]] && exit 0

# Allow Plan mode — orchestrator can write to ~/.claude/plans/
if [[ "$TOOL_NAME" == "Edit" ]] || [[ "$TOOL_NAME" == "Write" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  if [[ "$FILE_PATH" == *"/.claude/plans/"* ]]; then
    exit 0
  fi
fi

# Edit/Write/NotebookEdit: allowed for orchestrator on feature branches
# (enforce-branch-before-edit.sh already protects main/master)

# Validate provider_delegator agent invocations - block implementation agents
if [[ "$TOOL_NAME" == "mcp__provider_delegator__invoke_agent" ]]; then
  AGENT=$(echo "$INPUT" | jq -r '.tool_input.agent // empty')
  CODEX_ALLOWED="scout|detective|architect|scribe|code-reviewer"

  if [[ ! "$AGENT" =~ ^($CODEX_ALLOWED)$ ]]; then
    cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Agent '$AGENT' cannot be invoked via Codex. Implementation agents (*-supervisor, discovery) must use Task() with BEAD_ID for beads workflow."}}
EOF
    exit 0
  fi
fi

# Validate Bash commands for orchestrator
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  FIRST_WORD="${COMMAND%% *}"

  # ALLOW git commands (check second word for read vs write)
  if [[ "$FIRST_WORD" == "git" ]]; then
    SECOND_WORD=$(echo "$COMMAND" | awk '{print $2}')
    case "$SECOND_WORD" in
      status|log|diff|branch|checkout|merge|fetch|remote|stash|show|push|pull)
        exit 0
        ;;
      add|commit)
        # Allow git add/commit on feature branches, block on main/master
        CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
        if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
          cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Git '$SECOND_WORD' blocked on $CURRENT_BRANCH. Switch to a feature branch first."}}
EOF
          exit 0
        fi
        # Clean up stale index.lock left by bd pre-commit hook
        LOCK_FILE="$(git rev-parse --git-dir 2>/dev/null)/index.lock"
        if [[ -f "$LOCK_FILE" ]] && ! lsof "$LOCK_FILE" >/dev/null 2>&1; then
          rm -f "$LOCK_FILE"
        fi
        exit 0
        ;;
    esac
  fi

  # ALLOW beads commands (with validation)
  if [[ "$FIRST_WORD" == "bd" ]]; then
    SECOND_WORD=$(echo "$COMMAND" | awk '{print $2}')

    # Validate bd create requires description
    if [[ "$SECOND_WORD" == "create" ]] || [[ "$SECOND_WORD" == "new" ]]; then
      if [[ "$COMMAND" != *"-d "* ]] && [[ "$COMMAND" != *"--description "* ]] && [[ "$COMMAND" != *"--description="* ]]; then
        cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"bd create requires description (-d or --description) for supervisor context."}}
EOF
        exit 0
      fi
    fi

    exit 0
  fi

  # Allow other bash commands (npm, cargo, etc. for investigation)
  exit 0
fi

# Allow everything else
exit 0
