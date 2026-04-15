#!/bin/bash
#
# PostToolUse:Bash (async) - Auto-sync beads JSONL after bd mutations
#
# After any bd write command (create, update, close, dep, comments, reopen, delete),
# exports Dolt -> issues.jsonl so that bv/viewer sees changes immediately.
#
# In bd with Dolt backend, writes go to Dolt but JSONL is not auto-updated.
# bd sync is deprecated. We use bd export -o.
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only process Bash tool
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

# Extract the command that was executed
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

# Only process bd commands (not bv, not other tools)
echo "$COMMAND" | grep -qE '^\s*bd\s+' || exit 0

# Only trigger on write commands (skip read-only: list, show, ready, stats, etc.)
# Also skip 'bd export' itself to avoid infinite loop
echo "$COMMAND" | grep -qE 'bd\s+(create|update|close|dep|comments|reopen|delete|promote|merge-slot|move|refile|set-state|rename|duplicate|supersede|undefer|defer|label)\b' || exit 0

JSONL=".beads/issues.jsonl"

# Export fresh data from Dolt -> JSONL
bd export -o "$JSONL" --quiet 2>/dev/null || true

exit 0
