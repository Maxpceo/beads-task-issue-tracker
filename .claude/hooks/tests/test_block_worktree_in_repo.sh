#!/bin/bash
#
# Unit tests for block-worktree-in-repo.sh
#

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$TESTS_DIR/.." && pwd)"
HOOK="$HOOKS_DIR/block-worktree-in-repo.sh"

# shellcheck source=./test_helpers.sh
source "$TESTS_DIR/test_helpers.sh"

# Helper: run hook with a given bash command string, return "allow" or "deny"
run_hook() {
    local bash_cmd="$1"
    local input
    input=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$bash_cmd" | jq -Rs .)")
    local output
    output=$(printf '%s' "$input" | "$HOOK" 2>/dev/null)
    local decision
    decision=$(printf '%s' "$output" | jq -r '.decision // "approve"')
    printf '%s' "$decision"
}

assert_allow() {
    local description="$1" cmd="$2"
    local result
    result=$(run_hook "$cmd")
    if [[ "$result" == "approve" ]]; then
        pass "$description"
    else
        fail "$description" "expected: allow, got: $result  cmd='$cmd'"
    fi
}

assert_deny() {
    local description="$1" cmd="$2"
    local result
    result=$(run_hook "$cmd")
    if [[ "$result" == "block" ]]; then
        pass "$description"
    else
        fail "$description" "expected: deny (block), got: $result  cmd='$cmd'"
    fi
}

test_init "test_block_worktree_in_repo.sh"

EXTERNAL_PATH="$HOME/Projects/worktrees/beads-task-issue-tracker"

# --- Should DENY (relative/wrong path) ---
assert_deny \
    "bd worktree create relative name only — deny" \
    "bd worktree create bd-aef --branch bd-aef"

assert_deny \
    "git worktree add relative path — deny" \
    "git worktree add some-dir -b foo"

assert_deny \
    "git worktree add dotfile path — deny" \
    "git worktree add .worktrees/foo -b foo"

assert_deny \
    "bd worktree create flag before path — deny" \
    "bd worktree create --branch bd-aef bd-aef"

# --- Flag with value before path: parser must skip flag value ---
assert_allow \
    "bd worktree create --branch <X> <external-path> — allow (flag value не путается с path)" \
    "bd worktree create --branch foo ~/Projects/worktrees/beads-task-issue-tracker/bar"

assert_deny \
    "bd worktree create --branch <X> <relative-path> — deny (path всё ещё некорректен)" \
    "bd worktree create --branch foo bar"

assert_allow \
    "git worktree add -b <X> <external-path> — allow" \
    "git worktree add -b foo ~/Projects/worktrees/beads-task-issue-tracker/bar"

# --- Should ALLOW (correct external path) ---
assert_allow \
    "bd worktree create with ~ path — allow" \
    "bd worktree create ~/Projects/worktrees/beads-task-issue-tracker/bd-aef --branch bd-aef"

assert_allow \
    "bd worktree create with \$HOME path — allow" \
    "bd worktree create \$HOME/Projects/worktrees/beads-task-issue-tracker/bd-aef --branch bd-aef"

assert_allow \
    "bd worktree create with hardcoded absolute path — allow" \
    "bd worktree create ${EXTERNAL_PATH}/bd-aef --branch bd-aef"

assert_allow \
    "git worktree add with ~ path — allow" \
    "git worktree add ~/Projects/worktrees/beads-task-issue-tracker/foo -b foo"

# --- Non-create commands — should always ALLOW ---
assert_allow \
    "bd worktree list — allow" \
    "bd worktree list"

assert_allow \
    "bd worktree remove with external path — allow" \
    "bd worktree remove ~/Projects/worktrees/beads-task-issue-tracker/bd-aef"

assert_allow \
    "git worktree list — allow" \
    "git worktree list"

assert_allow \
    "git worktree remove — allow" \
    "git worktree remove some-worktree"

assert_allow \
    "git worktree prune — allow" \
    "git worktree prune"

# --- Multi-command (&&) ---
assert_allow \
    "bd worktree create external && cd — allow" \
    "bd worktree create ~/Projects/worktrees/beads-task-issue-tracker/bd-aef --branch bd-aef && cd \$_"

# --- String literal in echo — should NOT match ---
assert_allow \
    "echo string containing bd worktree create — allow (not a real invocation)" \
    'echo "bd worktree create foo"'

# --- Path traversal (`..`) — должен DENY даже если префикс совпадает ---
assert_deny \
    "path traversal via .. inside external prefix — deny" \
    "bd worktree create ~/Projects/worktrees/beads-task-issue-tracker/../../evil --branch evil"

assert_deny \
    "path traversal .. standalone — deny" \
    "bd worktree create ../escape --branch escape"

# --- Non-worktree Bash command — fast path approval ---
assert_allow \
    "ls command — fast path allow" \
    "ls -la"

assert_allow \
    "cat command — fast path allow" \
    "cat /etc/hosts"

# --- JSON escape: deny output must be valid JSON even if path has " or \ ---
json_valid_on_deny() {
    local description="$1" cmd="$2"
    local input
    input=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$cmd" | jq -Rs .)")
    local output
    output=$(printf '%s' "$input" | "$HOOK" 2>/dev/null)
    if printf '%s' "$output" | jq -e . >/dev/null 2>&1; then
        pass "$description"
    else
        fail "$description" "invalid JSON output: $output"
    fi
}

json_valid_on_deny \
    "deny output is valid JSON when path contains double quote" \
    'bd worktree create /tmp/bad"inject --branch foo'

test_summary
