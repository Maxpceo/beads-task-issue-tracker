#!/bin/bash
#
# Stop: Remind to create beads for pre-existing bugs
#
# Checks transcript for mentions of pre-existing bugs without corresponding bd create.
# Only fires after sessions with actual code work (Edit/Write/Task calls).
# Returns warning (not block) so the agent can still stop.
#

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

# No transcript — skip
[[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]] && echo '{}' && exit 0

# Was there actual code work in this session? (Edit, Write, or Task dispatch)
HAS_CODE_WORK=$(grep -cE '"(Edit|Write|MultiEdit|Task)"' "$TRANSCRIPT_PATH" 2>/dev/null || echo "0")

# No code work — just a conversation, skip
[[ "$HAS_CODE_WORK" -eq 0 ]] && echo '{}' && exit 0

# Check if "pre-existing" or similar phrases appear in transcript
HAS_PRE_EXISTING=$(grep -ciE "pre-existing|существовал до|баг.*не введён|ошибк.*до текущ|pre.existing" "$TRANSCRIPT_PATH" 2>/dev/null || echo "0")

# No mentions — nothing to remind
[[ "$HAS_PRE_EXISTING" -eq 0 ]] && echo '{}' && exit 0

# Check if bd create was called
HAS_BD_CREATE=$(grep -c 'bd create' "$TRANSCRIPT_PATH" 2>/dev/null || echo "0")

# If pre-existing mentioned but no bd create — warn
if [[ "$HAS_BD_CREATE" -eq 0 ]]; then
  cat << 'EOF'
{"systemMessage":"В этой сессии упоминались pre-existing баги, но bead не создан!\n\nПравило: bd create \"Bug: описание\" -d \"Найдено при работе. Баг существовал до текущих изменений.\"\n\nСоздай bead перед завершением."}
EOF
  exit 0
fi

echo '{}'
