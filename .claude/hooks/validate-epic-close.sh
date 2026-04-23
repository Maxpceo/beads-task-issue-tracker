#!/bin/bash
# Hook: Validate bead close — PR must be merged, epic children must be complete
# Prevents closing a bead whose branch has no merged PR
# Prevents closing an epic when children are still open

INPUT=$(cat)

# Only check Bash commands containing "bd close"
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Check if this is a bd close command
if ! echo "$COMMAND" | grep -qE 'bd\s+close'; then
  exit 0
fi

# Allow --force override
if echo "$COMMAND" | grep -qE '\-\-force'; then
  exit 0
fi

# Extract the ID being closed (handles: bd close ID, bd close ID && ..., etc.)
CLOSE_ID=$(echo "$COMMAND" | sed -E 's/.*bd[[:space:]]+close[[:space:]]+([A-Za-z0-9._-]+).*/\1/')

if [ -z "$CLOSE_ID" ]; then
  exit 0
fi

# === CHECK 1: PR merge validation ===
# Finds a remote branch whose name contains the bead ID in Conventional namespace
# (fix/bd-<id>, feat/bd-<id>, chore/bd-<id>, ...) OR legacy bare `bd-<id>`. If such a
# branch exists on origin, a merged PR is required. Otherwise — no branch == fast path
# or work done on a shared feature branch — skip the PR check.
HAS_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
if [ -n "$HAS_REMOTE" ]; then
  # Pattern matches: `bd-<id>` at end, or `<type>/bd-<id>` at end, or `<id>` at end.
  # ID is on a word boundary — `-` or end-of-string — so `bd-rst` doesn't match `bd-rst-hm5`.
  REMOTE_BRANCH=$(git ls-remote --heads origin 2>/dev/null \
    | awk '{print $2}' \
    | sed 's|^refs/heads/||' \
    | grep -E "(^|/)(bd-)?${CLOSE_ID}(-|$)" \
    | head -1)

  if [ -n "$REMOTE_BRANCH" ]; then
    if command -v gh >/dev/null 2>&1; then
      MERGED_PR=$(gh pr list --head "$REMOTE_BRANCH" --state merged --json number --jq '.[0].number' 2>/dev/null || echo "")

      if [ -z "$MERGED_PR" ]; then
        cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cannot close bead '$CLOSE_ID' — branch '$REMOTE_BRANCH' has no merged PR. Create and merge a PR first, or use 'bd close $CLOSE_ID --force' to override."}}
EOF
        exit 0
      fi
    fi
  fi
  # No branch matches CLOSE_ID on remote = fast-path or shared feature branch — skip PR check.
fi

# === CHECK 2: Epic children validation ===
# Check if this is an epic by looking at issue_type
ISSUE_TYPE=$(bd show "$CLOSE_ID" --json 2>/dev/null | jq -r '.[0].issue_type // ""' 2>/dev/null || echo "")

if [ "$ISSUE_TYPE" != "epic" ]; then
  # Not an epic, allow close
  exit 0
fi

# This is an epic - check if all children are complete
INCOMPLETE=$(bd list --json 2>/dev/null | jq -r --arg epic "$CLOSE_ID" '
  [.[] | select((.id | startswith($epic + ".")) and .status != "done" and .status != "closed")] | length
' 2>/dev/null || echo "0")

if [ "$INCOMPLETE" != "0" ] && [ "$INCOMPLETE" != "" ]; then
  # Get list of incomplete children for the error message
  INCOMPLETE_LIST=$(bd list --json 2>/dev/null | jq -r --arg epic "$CLOSE_ID" '
    [.[] | select((.id | startswith($epic + ".")) and .status != "done" and .status != "closed")] | .[] | "\(.id) (\(.status))"
  ' 2>/dev/null | tr '\n' ', ' | sed 's/,$//' || echo "unknown")

  cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cannot close epic '$CLOSE_ID' - has $INCOMPLETE incomplete children: $INCOMPLETE_LIST. Mark all children as done first."}}
EOF
  exit 0
fi

# All checks passed, allow close
exit 0
