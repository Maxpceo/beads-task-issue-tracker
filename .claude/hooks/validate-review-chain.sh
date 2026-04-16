#!/bin/bash
#
# PreToolUse:Bash - Validate review chain status before bd close
#
# Replaces 4 separate hooks (validate-simplify, validate-simplify-before-review,
# validate-code-review, validate-acceptance) with a single status-based check.
#
# For supervisor-path beads (have DISPATCH_PROMPT in comments):
#   - If acceptance_criteria set → status must be "accepted"
#   - If no acceptance_criteria → status must be "reviewed" or "accepted"
# For fast-path beads → no check needed
# Epics → skip (they aggregate children)
# --force → override

INPUT=$(cat)

# Only check Bash commands containing "bd close"
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -z "$COMMAND" ] && exit 0
echo "$COMMAND" | grep -qE 'bd\s+close' || exit 0

# Allow --force override
echo "$COMMAND" | grep -qE '\-\-force' && exit 0

# Extract the ID being closed (first ID after "bd close")
CLOSE_ID=$(echo "$COMMAND" | sed -E 's/.*bd[[:space:]]+close[[:space:]]+([A-Za-z0-9._-]+).*/\1/')
[ -z "$CLOSE_ID" ] && exit 0

# Skip merge-slot beads
echo "$CLOSE_ID" | grep -q "merge-slot" && exit 0

# Get bead details as JSON
BEAD_JSON=$(bd show "$CLOSE_ID" --json 2>/dev/null)
[ -z "$BEAD_JSON" ] && exit 0

# Skip epics — they just aggregate children
ISSUE_TYPE=$(echo "$BEAD_JSON" | jq -r '.[0].issue_type // ""' 2>/dev/null)
[ "$ISSUE_TYPE" = "epic" ] && exit 0

# Check if this is a supervisor-path bead (has DISPATCH_PROMPT in comments)
COMMENTS=$(bd show "$CLOSE_ID" 2>/dev/null || echo "")
echo "$COMMENTS" | grep -q "DISPATCH_PROMPT" || exit 0

# This is a supervisor-path bead — check status
CURRENT_STATUS=$(echo "$BEAD_JSON" | jq -r '.[0].status // ""' 2>/dev/null)

# Check if acceptance criteria are set
HAS_ACCEPTANCE=$(echo "$BEAD_JSON" | jq -r '.[0].acceptance_criteria // ""' 2>/dev/null)

if [ -n "$HAS_ACCEPTANCE" ] && [ "$HAS_ACCEPTANCE" != "null" ] && [ "$HAS_ACCEPTANCE" != "" ]; then
  # Has acceptance criteria → must be "accepted"
  if [ "$CURRENT_STATUS" = "accepted" ]; then
    exit 0
  fi
  cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cannot close bead '$CLOSE_ID' — review chain incomplete.\n\nCurrent status: $CURRENT_STATUS\nRequired status: accepted (bead has acceptance criteria)\n\nReview chain: inreview → simplified → reviewed → accepted → closed\nYou are here: $CURRENT_STATUS\n\nNext steps depend on current status:\n- inreview: run code-simplifier, then bd update $CLOSE_ID --status simplified\n- simplified: run code-reviewer, then bd update $CLOSE_ID --status reviewed\n- reviewed: run acceptance checks, then bd update $CLOSE_ID --status accepted\n\nOverride: bd close $CLOSE_ID --force"}}
EOF
  exit 0
else
  # No acceptance criteria → must be "reviewed" or "accepted"
  if [ "$CURRENT_STATUS" = "reviewed" ] || [ "$CURRENT_STATUS" = "accepted" ]; then
    exit 0
  fi
  cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cannot close bead '$CLOSE_ID' — review chain incomplete.\n\nCurrent status: $CURRENT_STATUS\nRequired status: reviewed (no acceptance criteria)\n\nReview chain: inreview → simplified → reviewed → closed\nYou are here: $CURRENT_STATUS\n\nNext steps depend on current status:\n- inreview: run code-simplifier, then bd update $CLOSE_ID --status simplified\n- simplified: run code-reviewer, then bd update $CLOSE_ID --status reviewed\n\nOverride: bd close $CLOSE_ID --force"}}
EOF
  exit 0
fi
