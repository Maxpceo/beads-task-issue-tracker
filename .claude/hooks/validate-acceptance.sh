#!/bin/bash
# Hook: Validate acceptance criteria before bd close
# Blocks closing a bead that has non-empty acceptance_criteria field
# but no ACCEPTANCE: record in comments.
# Skip: epics, --force flag, beads without acceptance_criteria.

INPUT=$(cat)

# Only check Bash commands containing "bd close"
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -z "$COMMAND" ] && exit 0
echo "$COMMAND" | grep -qE 'bd\s+close' || exit 0

# Allow --force override
echo "$COMMAND" | grep -qE '\-\-force' && exit 0

# Extract the ID being closed (first ID only)
CLOSE_ID=$(echo "$COMMAND" | sed -E 's/.*bd[[:space:]]+close[[:space:]]+([A-Za-z0-9._-]+).*/\1/')
[ -z "$CLOSE_ID" ] && exit 0

# Skip epics — they just aggregate children
ISSUE_TYPE=$(bd show "$CLOSE_ID" --json 2>/dev/null | jq -r '.[0].issue_type // ""' 2>/dev/null || echo "")
[ "$ISSUE_TYPE" = "epic" ] && exit 0

# Check if bead has non-empty acceptance_criteria field (structural check, not keyword-based)
# Use count query to avoid encoding issues with Cyrillic text
HAS_ACCEPTANCE=$(bd sql "SELECT COUNT(*) as cnt FROM issues WHERE id = '$CLOSE_ID' AND length(acceptance_criteria) > 0" 2>/dev/null | grep -oE '^[0-9]+' | head -1)

# If acceptance_criteria is empty — no acceptance required, allow close
[ "$HAS_ACCEPTANCE" != "1" ] && exit 0

# Has acceptance criteria — check for ACCEPTANCE: record in comments
COMMENTS=$(bd show "$CLOSE_ID" 2>/dev/null || echo "")
if echo "$COMMENTS" | grep -qiE "ACCEPTANCE:"; then
  exit 0
fi

# No ACCEPTANCE record found — block close
cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cannot close bead '$CLOSE_ID' — acceptance criteria not fulfilled.\n\nRun: bd show $CLOSE_ID to see acceptance criteria.\n\nOptions:\n1. Perform acceptance checks, then: bd comments add $CLOSE_ID \"ACCEPTANCE: PASSED. [what was verified]\"\n2. Override: bd close $CLOSE_ID --force"}}
EOF
exit 0
