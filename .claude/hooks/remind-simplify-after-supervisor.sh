#!/bin/bash
#
# PostToolUse: Remind orchestrator to run code-simplifier after supervisor completes
#
# Problem: orchestrator consistently skips the simplify step after supervisor
# returns because the instruction is buried deep in CLAUDE.md context.
# Solution: inject a reminder at exactly the right moment (PostToolUse on Task).
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Task tool responses
[[ "$TOOL_NAME" != "Task" ]] && exit 0

# Get the tool response
RESPONSE=$(echo "$INPUT" | jq -r '.tool_result // empty')
[[ -z "$RESPONSE" ]] && exit 0

# Detect supervisor completion (contains "BEAD ... COMPLETE")
if echo "$RESPONSE" | grep -qE "BEAD.+COMPLETE"; then
  cat << 'REMINDER'
<system-reminder>
SIMPLIFY STEP — НЕ ПРОПУСКАЙ!

Supervisor завершил работу. ПЕРЕД code review ты ОБЯЗАН:

1. Dispatch code-simplifier:
Task(
  subagent_type="code-simplifier",
  prompt="BEAD_ID: {BEAD_ID}\nBRANCH: {branch}\nSTART_COMMIT: {hash}\n\nSimplify git diff {hash}..HEAD"
)

2. После возврата — ОБЯЗАТЕЛЬНО обновить статус бида:
bd update {BEAD_ID} --status simplified

Без статуса simplified: хук validate-review-chain заблокирует bd close!

Порядок статусов: inreview → simplified (ТЫ ЗДЕСЬ) → reviewed → accepted → closed
                                                 Code Review    Acceptance     Orchestrator closes
</system-reminder>
REMINDER
fi

exit 0
