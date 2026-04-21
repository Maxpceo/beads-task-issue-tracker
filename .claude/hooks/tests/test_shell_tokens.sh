#!/bin/bash
#
# Unit tests for lib/shell-tokens.sh :: command_contains_token
#

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$TESTS_DIR/.." && pwd)"
# shellcheck source=./test_helpers.sh
source "$TESTS_DIR/test_helpers.sh"
# shellcheck source=../lib/shell-tokens.sh
source "$HOOKS_DIR/lib/shell-tokens.sh"

assert_match() {
  local description="$1" cmd="$2" pattern="$3"
  if command_contains_token "$cmd" "$pattern"; then
    pass "$description"
  else
    fail "$description" "cmd='$cmd'  pattern='$pattern'  expected: MATCH"
  fi
}

assert_no_match() {
  local description="$1" cmd="$2" pattern="$3"
  if ! command_contains_token "$cmd" "$pattern"; then
    pass "$description"
  else
    fail "$description" "cmd='$cmd'  pattern='$pattern'  expected: NO MATCH"
  fi
}

test_init "test_shell_tokens.sh"

# --- Basic match cases ---
assert_match "bare git push at start"        "git push"                                       "git[[:space:]]+push"
assert_match "git push after &&"             "cd x && git push"                               "git[[:space:]]+push"
assert_match "git push after semicolon"      "echo done; git push"                            "git[[:space:]]+push"
assert_match "git push in pipeline"          "true | git push origin main"                    "git[[:space:]]+push"
assert_match "bd close bare"                 "bd close beads-task-issue-tracker-abc"          "bd[[:space:]]+close"
assert_match "git commit bare"               "git commit -m 'msg'"                            "git[[:space:]]+commit"

# --- False-positive prevention cases ---
assert_no_match \
  "git push inside double-quoted string" \
  'bd comments add ID "planning: avoid git push by supervisor"' \
  "git[[:space:]]+push"

assert_no_match \
  "bd close inside single-quoted string" \
  "bd comments add ID 'workflow: bd close is orchestrator job'" \
  "bd[[:space:]]+close"

assert_no_match \
  "git push in echo to file — quoted arg" \
  "echo 'git push' > file.txt" \
  "git[[:space:]]+push"

assert_no_match \
  "unrelated command with similar substring" \
  "git commit -m 'feat: no push here'" \
  "git[[:space:]]+push"

assert_no_match \
  "pattern in double-quoted commit message" \
  'git commit -m "fix: remove bd close call"' \
  "bd[[:space:]]+close"

assert_no_match \
  "bd update --status in quoted text" \
  'bd comments add ID "docs: bd update --status reviewed by orchestrator"' \
  "bd[[:space:]]+update.*--status[[:space:]]+(simplified|reviewed|accepted)"

# --- Multiline quoted string cases ---
assert_no_match \
  "git push inside multiline double-quoted string" \
  "$(printf 'bd comments add ID "line 1\nthis contains git push as text\nline 3"')" \
  "git[[:space:]]+push"

assert_no_match \
  "bd close inside multiline double-quoted string" \
  "$(printf 'bd comments add ID "verdict:\ndo not run bd close from subagent\nend"')" \
  "bd[[:space:]]+close"

assert_no_match \
  "git push inside multiline single-quoted string" \
  "$(printf "bd comments add ID 'line 1\ngit push is mentioned here\nline 3'")" \
  "git[[:space:]]+push"

assert_no_match \
  "CODE REVIEW verdict multiline with trigger pattern" \
  "$(printf 'bd comments add ID "CODE REVIEW: NOT APPROVED\nreason: supervisor must not run git push\nfix required"')" \
  "git[[:space:]]+push"

test_summary
