#!/bin/bash
# Блокирует создание worktree вне external layout
# Матчит: bd worktree create, git worktree add
# Пропускает: bd worktree list/remove/info/prune, git worktree list/remove/prune
# Claude Code PreToolUse hook для Bash

INPUT=$(cat)

# Single jq call — extract tool_name + command via TSV
IFS=$'\t' read -r TOOL CMD < <(printf '%s' "$INPUT" | jq -r '[.tool_name // "", (.tool_input.command // "")] | @tsv')
[[ "$TOOL" != "Bash" || -z "$CMD" ]] && echo '{"decision":"approve"}' && exit 0

# Bash-builtin pre-filter — отсекает ~99% non-worktree команд за 0 fork'ов
[[ "$CMD" != *worktree* ]] && echo '{"decision":"approve"}' && exit 0

# Any `..` in the path is a path-traversal attempt — stock macOS `realpath`
# can't normalize non-existent paths, so we can't safely resolve; reject instead.
# Worktree paths have no legitimate reason for `..`.

HOOKS_LIB="${CLAUDE_PROJECT_DIR:+${CLAUDE_PROJECT_DIR}/.claude/hooks/lib}"
if [[ -z "$HOOKS_LIB" ]]; then
    _SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    HOOKS_LIB="${_SCRIPT_DIR}/lib"
fi
# shellcheck source=lib/shell-tokens.sh
source "$HOOKS_LIB/shell-tokens.sh"

if ! command_contains_token "$CMD" "(bd[[:space:]]+worktree[[:space:]]+create|git[[:space:]]+worktree[[:space:]]+add)"; then
    echo '{"decision":"approve"}'
    exit 0
fi

EXPECTED_BASE="${HOME}/Projects/worktrees/beads-task-issue-tracker"

extract_worktree_path() {
    local subcmd="$1"
    local keyword
    keyword=$(printf '%s' "$subcmd" | grep -oE '(^|[[:space:]])(bd[[:space:]]+worktree[[:space:]]+create|git[[:space:]]+worktree[[:space:]]+add)([[:space:]]|$)' | head -1)
    [[ -z "$keyword" ]] && return 1

    local after_kw
    after_kw=$(printf '%s' "$subcmd" | sed -E "s/.*(bd[[:space:]]+worktree[[:space:]]+create|git[[:space:]]+worktree[[:space:]]+add)[[:space:]]*//")

    local token path_arg=""
    local save_ifs="$IFS"
    IFS=' '$'\t'
    # shellcheck disable=SC2086
    set -- $after_kw
    IFS="$save_ifs"
    for token in "$@"; do
        if [[ "$token" != -* ]]; then
            path_arg="$token"
            break
        fi
    done

    [[ -z "$path_arg" ]] && return 1
    printf '%s' "$path_arg"
}

stripped=$(printf '%s' "$CMD" | tr '\n' ' ' | sed -E -e "s/'[^']*'//g" -e 's/"[^"]*"//g')

while IFS= read -r segment; do
    segment="${segment#"${segment%%[![:space:]]*}"}"
    [[ -z "$segment" ]] && continue

    path_arg=$(extract_worktree_path "$segment") || continue

    # Expand leading ~ and $HOME
    [[ "$path_arg" == \~* ]]     && path_arg="${path_arg/#\~/$HOME}"
    [[ "$path_arg" == \$HOME* ]] && path_arg="${path_arg/\$HOME/$HOME}"

    # Reject any path-traversal attempt (`..` is never legitimate here)
    if [[ "$path_arg" == *..* ]]; then
        printf '{"decision":"block","reason":"Worktree path содержит `..` — это не допускается. Используй абсолютный путь в `~/Projects/worktrees/beads-task-issue-tracker/<name>`."}\n'
        exit 2
    fi

    if [[ "$path_arg" == "${EXPECTED_BASE}"/* ]]; then
        continue
    fi

    printf '{"decision":"block","reason":"Worktree должен быть в `~/Projects/worktrees/beads-task-issue-tracker/<name>` — путь `%s` не подходит. См. `.claude/references/bd-worktrees.md`."}\n' "$path_arg"
    exit 2
done < <(printf '%s\n' "$stripped" | tr ';&|' '\n')

echo '{"decision":"approve"}'
