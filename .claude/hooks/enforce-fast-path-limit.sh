#!/bin/bash
#
# PreToolUse:Edit/Write — Enforce orchestrator workflow boundaries
#
# Two checks:
# 1. If bead in_progress exists → remind orchestrator to use supervisor
#    (fires on FIRST new code file — orchestrator shouldn't write code when bead is claimed)
# 2. If no bead + 2+ code files → require bead creation
#
# Fires as a reminder (not a block) — orchestrator may consciously decide to
# do small cross-file edits, but the default should be supervisor dispatch.
#

INPUT=$(cat)

# Get the file being edited
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE_PATH" ] && exit 0

# Only check code files (skip .beads/, .claude/, .md, .json, .jsonl, _bmad-output/)
echo "$FILE_PATH" | grep -qE '^\.(beads|claude)/' && exit 0
echo "$FILE_PATH" | grep -qE '/\.(beads|claude)/' && exit 0
echo "$FILE_PATH" | grep -qE '\.(md|json|jsonl)$' && exit 0
echo "$FILE_PATH" | grep -qE '_bmad-output/' && exit 0

# Count ALREADY modified code files (unstaged + staged, excluding infra)
MODIFIED_CODE_FILES=$(git diff --name-only HEAD 2>/dev/null | grep -vE '^\.(beads|claude)/' | grep -vE '\.(md|json|jsonl)$' | grep -vE '_bmad-output/' || true)

# Also count untracked code files (new files not yet committed)
UNTRACKED_CODE_FILES=$(git ls-files --others --exclude-standard 2>/dev/null | grep -vE '^\.(beads|claude)/' | grep -vE '\.(md|json|jsonl)$' | grep -vE '_bmad-output/' || true)

# Combine and deduplicate
ALL_CHANGED=$(printf '%s\n%s\n' "$MODIFIED_CODE_FILES" "$UNTRACKED_CODE_FILES" | grep -v '^$' | sort -u || true)

if [ -z "$ALL_CHANGED" ]; then
  CHANGED_COUNT=0
else
  CHANGED_COUNT=$(echo "$ALL_CHANGED" | wc -l | tr -d ' ')
fi

# Normalize current file path (strip absolute prefix to project root)
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -n "$PROJECT_ROOT" ]; then
  NORM_FILE=$(echo "$FILE_PATH" | sed "s|^${PROJECT_ROOT}/||; s|^\./||")
else
  NORM_FILE=$(echo "$FILE_PATH" | sed 's|^\./||')
fi

# Is current file already in the changed list?
ALREADY_CHANGED="false"
echo "$ALL_CHANGED" | grep -qF "$NORM_FILE" && ALREADY_CHANGED="true"

# If file is already changed — this is a re-edit, not a new file. Allow silently.
[ "$ALREADY_CHANGED" = "true" ] && exit 0

# This is a NEW code file being edited. After this edit, total = CHANGED_COUNT + 1
TOTAL_AFTER=$((CHANGED_COUNT + 1))

# Check if there's a non-epic bead in_progress
NON_EPIC_IN_PROGRESS=$(bd list --status=in_progress 2>/dev/null | grep -v '\[epic\]' | grep -oE '[A-Za-z0-9_-]+-[A-Za-z0-9._]+' || true)

# === CHECK 1: Bead in_progress + editing code ===
if [ -n "$NON_EPIC_IN_PROGRESS" ]; then
  # Fast Path exception: allow if this is the FIRST and ONLY code file (0 changed so far)
  # This covers 1-file hotfixes unrelated to the in_progress bead
  if [ "$CHANGED_COUNT" -eq 0 ]; then
    cat << EOF
<system-reminder>
FAST PATH при bead in_progress — разрешено (1 файл).

Bead: ${NON_EPIC_IN_PROGRESS} (не твой — из другой задачи/сессии)
Файл: ${NORM_FILE}

Это Fast Path — 1 файл, мелкая правка. Разрешено без supervisor.
Если правишь ВТОРОЙ файл — хук заблокирует. Для крупных правок используй supervisor.
</system-reminder>
EOF
    exit 0
  fi

  # 2+ files with bead in_progress → block
  cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"SUPERVISOR REQUIRED — bead ${NON_EPIC_IN_PROGRESS} in_progress + уже изменено ${CHANGED_COUNT} файл(ов). Fast Path разрешает максимум 1 файл при bead in_progress. Dispatch supervisor или закрой bead."}}
EOF
  exit 0
fi

# === CHECK 2: No bead + 2+ code files = need bead ===
[ "$TOTAL_AFTER" -le 1 ] && exit 0

cat << EOF
<system-reminder>
FAST PATH LIMIT EXCEEDED — нужен bead!

Ты редактируешь ${TOTAL_AFTER}-й code-файл без bead in_progress.
Fast Path: максимум 1 файл. Ты вышел за его рамки.

Уже изменены:
$(echo "$ALL_CHANGED" | head -5)

Сейчас редактируешь: ${NORM_FILE}

ЧТО ДЕЛАТЬ:
1. bd update {BEAD_ID} --claim  (если bead есть)
2. bd create "..." && bd update {ID} --claim  (если нет)
3. Подумай: нужен ли dispatch supervisor вместо прямого редактирования?

Если это осознанное решение — продолжай, но bead ОБЯЗАТЕЛЕН.
</system-reminder>
EOF

exit 0
