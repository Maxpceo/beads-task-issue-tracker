#!/bin/bash
#
# PreToolUse:Task - Soft reminder to set bead status and acceptance criteria before dispatch
#

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

# Only remind if dispatching a bead task (prompt contains BEAD_ID)
if [[ "$PROMPT" == *"BEAD_ID:"* ]]; then
  # Extract BEAD_ID from prompt
  BEAD_ID=$(echo "$PROMPT" | grep -oE 'BEAD_ID:[[:space:]]*[A-Za-z0-9._-]+' | head -1 | sed 's/BEAD_ID:[[:space:]]*//')

  REMINDERS="IMPORTANT: Before dispatching, ensure bead is in_progress: bd update {BEAD_ID} --status in_progress"

  # Check if acceptance_criteria is set
  if [[ -n "$BEAD_ID" ]]; then
    HAS_ACCEPTANCE=$(bd sql "SELECT COUNT(*) as cnt FROM issues WHERE id = '$BEAD_ID' AND length(acceptance_criteria) > 0" 2>/dev/null | grep -oE '[0-9]+' | tail -1)
    if [[ "$HAS_ACCEPTANCE" != "1" ]]; then
      REMINDERS="$REMINDERS
WARNING: Bead '$BEAD_ID' has no acceptance criteria. Set them now: bd update $BEAD_ID --acceptance \"1. Тесты проходят. 2. ...\""
    fi
  fi

  echo "$REMINDERS"
fi

exit 0
