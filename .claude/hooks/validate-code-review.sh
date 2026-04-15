#!/bin/bash
# Hook: Validate code review before bd close
# Blocks closing a supervisor-path bead that hasn't been code-reviewed.
# Detection: if bead has DISPATCH_PROMPT in comments → supervisor-path → requires APPROVED.
# Skip: epics (they aggregate children), --force flag, beads without DISPATCH_PROMPT.

INPUT=$(cat)

# Only check Bash commands containing "bd close"
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -z "$COMMAND" ] && exit 0
echo "$COMMAND" | grep -qE 'bd\s+close' || exit 0

# Allow --force override
echo "$COMMAND" | grep -qE '\-\-force' && exit 0

# Extract the ID being closed
CLOSE_ID=$(echo "$COMMAND" | sed -E 's/.*bd[[:space:]]+close[[:space:]]+([A-Za-z0-9._-]+).*/\1/')
[ -z "$CLOSE_ID" ] && exit 0

# Skip epics — they just aggregate children
ISSUE_TYPE=$(bd show "$CLOSE_ID" --json 2>/dev/null | jq -r '.[0].issue_type // ""' 2>/dev/null || echo "")
[ "$ISSUE_TYPE" = "epic" ] && exit 0

# Check if this is a supervisor-path bead (has DISPATCH_PROMPT in comments)
COMMENTS=$(bd show "$CLOSE_ID" 2>/dev/null || echo "")
echo "$COMMENTS" | grep -q "DISPATCH_PROMPT" || exit 0

# This is a supervisor-path bead — check for APPROVED in comments
if echo "$COMMENTS" | grep -qi "APPROVED"; then
  exit 0
fi

# No APPROVED found — block close
cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cannot close bead '$CLOSE_ID' — no code review APPROVED found in comments. Run code-reviewer first, or use 'bd close $CLOSE_ID --force' to override."}}
EOF
exit 0
