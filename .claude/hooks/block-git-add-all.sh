#!/bin/bash
# Блокирует git add -A, git add . и git add --all
# Заставляет агентов перечислять файлы по именам
# Claude Code PreToolUse hook для Bash

INPUT=$(cat)

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[[ "$TOOL" != "Bash" ]] && echo '{"decision":"approve"}' && exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$CMD" ]] && echo '{"decision":"approve"}' && exit 0

# Source shared token helper for quote-aware matching
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_LIB="${CLAUDE_PROJECT_DIR:+${CLAUDE_PROJECT_DIR}/.claude/hooks/lib}"
[[ -z "$HOOKS_LIB" ]] && HOOKS_LIB="${_SCRIPT_DIR}/lib"
# shellcheck source=lib/shell-tokens.sh
source "$HOOKS_LIB/shell-tokens.sh"

# Block git add -A / --all / .  (broad-add patterns)
# command_contains_token strips quoted strings and enforces shell-token boundaries,
# so patterns inside quoted arguments (e.g. in bd comments) don't false-positive.
if command_contains_token "$CMD" "git[[:space:]]+add[[:space:]]+(-A|--all|\.)"; then
    echo '{"decision":"block","message":"ЗАБЛОКИРОВАНО: git add -A / git add . / git add --all запрещены. Добавляй файлы по именам: git add file1.ts file2.vue ..."}'
    exit 0
fi

# Block git commit -a
if command_contains_token "$CMD" "git[[:space:]]+commit[[:space:]]+.*-[a-zA-Z]*a"; then
    echo '{"decision":"block","message":"ЗАБЛОКИРОВАНО: git commit -a запрещён. Сначала git add <файлы по именам>, потом git commit."}'
    exit 0
fi

echo '{"decision":"approve"}'
