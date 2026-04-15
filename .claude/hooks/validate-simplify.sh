#!/bin/bash
# Hook: Validate simplify before bd close
# Blocks closing a supervisor-path bead that hasn't been simplified.
# Detection: if bead has DISPATCH_PROMPT in comments → supervisor-path → requires SIMPLIFY:.
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

# This is a supervisor-path bead — check for SIMPLIFY: in comments
if echo "$COMMENTS" | grep -qiE "SIMPLIFY:"; then
  exit 0
fi

# No SIMPLIFY record found — block close
cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cannot close bead '$CLOSE_ID' — simplify not performed.\n\nWorkflow: Supervisor → Simplify (MISSING) → Code Review → Close\n\nOptions:\n1. Dispatch code-simplifier, then: bd comments add $CLOSE_ID \"SIMPLIFY: DONE. [summary]\"\n2. No code changes needed: bd comments add $CLOSE_ID \"SIMPLIFY: SKIPPED. docs/config only\"\n3. Override: bd close $CLOSE_ID --force"}}
EOF
exit 0
