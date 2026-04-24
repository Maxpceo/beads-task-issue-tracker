#!/bin/bash
# Блокирует создание worktree вне external layout
# Матчит: bd worktree create, git worktree add
# Пропускает: bd worktree list/remove/info/prune, git worktree list/remove/prune
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

# Quick-exit: no create/add pattern anywhere → approve immediately
if ! command_contains_token "$CMD" "(bd[[:space:]]+worktree[[:space:]]+create|git[[:space:]]+worktree[[:space:]]+add)"; then
    echo '{"decision":"approve"}'
    exit 0
fi

# Expected external base path (must end without trailing slash)
EXPECTED_BASE="${HOME}/Projects/worktrees/beads-task-issue-tracker"

# Expand ~ and $HOME in a path string
expand_path() {
    local p="$1"
    [[ "$p" == \~* ]]     && p="${p/#\~/$HOME}"
    [[ "$p" == \$HOME* ]] && p="${p/\$HOME/$HOME}"
    printf '%s' "$p"
}

# Given a single sub-command string (already quote-stripped), extract the first
# non-flag positional argument after "bd worktree create" or "git worktree add".
# Prints the extracted path to stdout; returns 1 if no relevant sub-command found.
extract_worktree_path() {
    local subcmd="$1"
    local keyword=""

    if printf '%s' "$subcmd" | grep -qE '(^|[[:space:]])bd[[:space:]]+worktree[[:space:]]+create([[:space:]]|$)'; then
        keyword="bd[[:space:]]+worktree[[:space:]]+create"
    elif printf '%s' "$subcmd" | grep -qE '(^|[[:space:]])git[[:space:]]+worktree[[:space:]]+add([[:space:]]|$)'; then
        keyword="git[[:space:]]+worktree[[:space:]]+add"
    else
        return 1  # not a create/add sub-command
    fi

    # Get everything after the keyword
    local after_kw
    after_kw=$(printf '%s' "$subcmd" | sed -E "s/.*${keyword}[[:space:]]*//" )

    # Find first non-flag token (use default IFS=space for word-splitting)
    local token path_arg=""
    local save_ifs="$IFS"
    IFS=' '$'\t'
    # shellcheck disable=SC2086
    set -- $after_kw
    IFS="$save_ifs"
    for token in "$@"; do
        if [[ "$token" != --* && "$token" != -* ]]; then
            path_arg="$token"
            break
        fi
    done

    [[ -z "$path_arg" ]] && return 1

    printf '%s' "$path_arg"
    return 0
}

# Strip quoted strings from full command for splitting (same approach as shell-tokens.sh)
stripped=$(printf '%s' "$CMD" | tr '\n' ' ' | sed -E -e "s/'[^']*'//g" -e 's/"[^"]*"//g')

# Split on && ; | to get individual sub-commands
while IFS= read -r segment; do
    # Trim leading whitespace
    segment="${segment#"${segment%%[![:space:]]*}"}"
    [[ -z "$segment" ]] && continue

    path_arg=$(extract_worktree_path "$segment") || continue

    # Expand ~ and $HOME
    path_arg=$(expand_path "$path_arg")

    # Normalize (resolve . and .. without requiring path to exist)
    resolved=$(realpath -m "$path_arg" 2>/dev/null || printf '%s' "$path_arg")

    # Allow if inside expected base
    if [[ "$resolved" == "${EXPECTED_BASE}"/* ]]; then
        continue
    fi

    # Block
    printf '{"decision":"block","reason":"Worktree должен быть в `~/Projects/worktrees/beads-task-issue-tracker/<name>` — путь `%s` не подходит. См. `.claude/references/bd-worktrees.md`."}\n' "$resolved"
    exit 2

done < <(printf '%s\n' "$stripped" | tr ';&|' '\n')

echo '{"decision":"approve"}'
