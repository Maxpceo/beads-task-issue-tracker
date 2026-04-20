#!/bin/bash
#
# PreToolUse:Bash — блокирует коммит в stale worktree относительно origin/main
#
# Проблема: worktree создаётся от HEAD feature-ветки. Пока supervisor правит код
# в worktree, в main параллельно мёрджатся другие PR. Коммит поверх устаревшего
# снапшота может «затереть» уже мёрдженную работу (франкенштейн-коммит).
#
# Решение: при git commit/cherry-pick/rebase/revert/merge в linked worktree
# сравниваем merge-base(HEAD, origin/main) с origin/main. Если ветка отстала
# И staged файлы пересекаются с изменениями в main — hard deny. Если отстала,
# но пересечения нет — soft reminder. Иначе тихо пропускаем.
#
# Escape hatch: CLAUDE_SKIP_STALE_CHECK=1.
#
# ВАЖНО: best-effort check, не атомарность. Между проверкой и реальным
# коммитом origin/main может уйти дальше — это известное ограничение.
#

# Escape hatch из env процесса hook'а (работает, если Claude Code CLI запущен с этой переменной)
[[ "${CLAUDE_SKIP_STALE_CHECK:-}" == "1" ]] && exit 0

INPUT=$(cat)

# Только Bash — защитная проверка (matcher уже отфильтровал)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[[ -z "$COMMAND" ]] && exit 0

# Escape hatch inline-префиксом в COMMAND (CLAUDE_SKIP_STALE_CHECK=1 git commit ...).
# Hook запускается отдельным процессом до исполнения Bash tool'а, поэтому inline ENV-префикс
# виден только дочернему shell'у команды — не hook'у. Парсим вручную.
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|(])CLAUDE_SKIP_STALE_CHECK=1([[:space:]]|$)'; then
  exit 0
fi

# Claude Code запускает хуки с CWD процесса = project root, не CWD Bash tool'а.
# Для корректной работы git-команд в worktree читаем .cwd из envelope.
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
cd "${CWD:-$(pwd)}" 2>/dev/null || exit 0

# Подключаем helper для token-aware matching
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_LIB="${CLAUDE_PROJECT_DIR:+${CLAUDE_PROJECT_DIR}/.claude/hooks/lib}"
[[ -z "$HOOKS_LIB" ]] && HOOKS_LIB="${_SCRIPT_DIR}/lib"
# shellcheck source=lib/shell-tokens.sh
source "$HOOKS_LIB/shell-tokens.sh"

# Расширенный matcher: все команды, способные создать коммит
command_contains_token "$COMMAND" "git[[:space:]]+(commit|cherry-pick|rebase|revert|merge)" || exit 0

# sync beads — служебный коммит, пропускаем
if echo "$COMMAND" | grep -qE 'sync beads'; then
  exit 0
fi

# Detection worktree через git-структуру (не по пути)
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)

# Не git-репо или нет доступа — тихо выходим
[[ -z "$GIT_DIR" || -z "$GIT_COMMON_DIR" ]] && exit 0

# Нормализуем к абсолютным путям для надёжного сравнения
ABS_GIT_DIR=$(cd "$GIT_DIR" 2>/dev/null && pwd)
ABS_COMMON_DIR=$(cd "$GIT_COMMON_DIR" 2>/dev/null && pwd)

# Не worktree — не наше дело
[[ "$ABS_GIT_DIR" == "$ABS_COMMON_DIR" ]] && exit 0

# --- Вычисляем возраст FETCH_HEAD (корневой, не worktree) ---
# Если файла нет или он старше 15 минут — даём подсказку про `git fetch origin`.
FETCH_HEAD_PATH="$ABS_COMMON_DIR/FETCH_HEAD"
FETCH_HINT=""
FETCH_MTIME=0
if [[ -f "$FETCH_HEAD_PATH" ]]; then
  # BSD (macOS) сначала, fallback GNU (Linux)
  FETCH_MTIME=$(stat -f %m "$FETCH_HEAD_PATH" 2>/dev/null || stat -c %Y "$FETCH_HEAD_PATH" 2>/dev/null || echo 0)
fi
if (( $(date +%s) - FETCH_MTIME > 900 )); then
  FETCH_HINT="⚠ origin/main возможно устарел (FETCH_HEAD >15 мин). Сначала \`git fetch origin\`."
fi

# --- Проверка существования origin/main ---
if ! ORIGIN_MAIN=$(git rev-parse origin/main 2>/dev/null); then
  cat << EOF
<system-reminder>
origin/main не найден локально, сделай \`git fetch origin\`.
${FETCH_HINT}
</system-reminder>
EOF
  exit 0
fi

# --- Stale check: merge-base vs origin/main ---
MERGE_BASE=$(git merge-base HEAD origin/main 2>/dev/null)
if [[ -z "$MERGE_BASE" ]]; then
  # Нет общего предка — edge case, не блокируем
  exit 0
fi

if [[ "$MERGE_BASE" == "$ORIGIN_MAIN" ]]; then
  # Ветка свежая относительно origin/main
  # Но FETCH_HEAD мог протухнуть — мягкое напоминание
  if [[ -n "$FETCH_HINT" ]]; then
    cat << EOF
<system-reminder>
${FETCH_HINT}
</system-reminder>
EOF
  fi
  exit 0
fi

# --- Staged файлы ---
STAGED=$(git diff --cached --name-only 2>/dev/null)
# Пустой commit (amend без staged / whatever) — не наше дело
[[ -z "$STAGED" ]] && exit 0

# Фильтр «коммитов ни при чём»: только .beads/, .claude/, *.md, *.json, *.jsonl
NON_META=$(printf '%s\n' "$STAGED" | grep -vE '^\.(beads|claude)/|\.(md|json|jsonl)$' || true)
[[ -z "$NON_META" ]] && exit 0

# --- Diff с origin/main для определения пересечений ---
MAIN_DIFF=$(git diff --name-only "$MERGE_BASE" "$ORIGIN_MAIN" 2>/dev/null)

# Количество коммитов отставания
BEHIND_COUNT=$(git rev-list --count "$MERGE_BASE..$ORIGIN_MAIN" 2>/dev/null || echo "?")

# Текущая ветка
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")

# Пересечение staged и main_diff
INTERSECT=""
if [[ -n "$MAIN_DIFF" ]]; then
  INTERSECT=$(comm -12 <(printf '%s\n' "$STAGED" | sort -u) <(printf '%s\n' "$MAIN_DIFF" | sort -u))
fi

if [[ -n "$INTERSECT" ]]; then
  # HARD DENY — пересечение файлов, риск франкенштейн-коммита
  INTERSECT_TOP=$(printf '%s\n' "$INTERSECT" | head -5)
  INTERSECT_COUNT=$(printf '%s\n' "$INTERSECT" | wc -l | tr -d ' ')

  FETCH_BLOCK=""
  [[ -n "$FETCH_HINT" ]] && FETCH_BLOCK=$'\n\n'"$FETCH_HINT"
  REASON=$(cat << EOF
Коммит в worktree заблокирован: ветка '${CURRENT_BRANCH}' отстала от origin/main на ${BEHIND_COUNT} коммит(ов), и staged файлы пересекаются с изменениями в main (${INTERSECT_COUNT} файл(ов)).

Пересекающиеся файлы (первые 5):
${INTERSECT_TOP}

Как исправить: \`git fetch origin && git rebase origin/main\`, затем повторить коммит.

Override (на свой риск): \`CLAUDE_SKIP_STALE_CHECK=1 git commit ...\`.${FETCH_BLOCK}
EOF
)

  # JSON permissionDecision=deny
  printf '%s' "$REASON" | jq -Rsc '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: .
    }
  }'
  exit 0
fi

# SOFT reminder — ветка отстала, но пересечения нет
cat << EOF
<system-reminder>
WORKTREE STALE vs origin/main (пересечения файлов нет)

Ветка '${CURRENT_BRANCH}' отстала от origin/main на ${BEHIND_COUNT} коммит(ов).
Staged файлы не пересекаются с изменениями в main — коммит безопасен, но
рекомендую перед push сделать: \`git fetch origin && git rebase origin/main\`.

Override: CLAUDE_SKIP_STALE_CHECK=1.
${FETCH_HINT}
</system-reminder>
EOF

exit 0
