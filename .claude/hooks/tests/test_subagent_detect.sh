#!/bin/bash
#
# Unit tests for lib/subagent-detect.sh :: is_subagent
#
# Test strategy:
#   - CWD worktree detection via INPUT JSON (external layout only)
#   - Marker file detection via real temp files
#   - TTL-guard: marker older than 30 min → treated as stale (not subagent)
#   - No signals → orchestrator
#   - Legacy .worktrees/ path → orchestrator (layout removed)
#

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$TESTS_DIR/.." && pwd)"
# shellcheck source=./test_helpers.sh
source "$TESTS_DIR/test_helpers.sh"
# shellcheck source=../lib/subagent-detect.sh
source "$HOOKS_DIR/lib/subagent-detect.sh"

assert_subagent() {
  local description="$1" input_json="$2"
  if is_subagent "$input_json"; then
    pass "$description"
  else
    fail "$description" "expected: subagent"
  fi
}

assert_orchestrator() {
  local description="$1" input_json="$2"
  if ! is_subagent "$input_json"; then
    pass "$description"
  else
    fail "$description" "expected: orchestrator"
  fi
}

# Portable "touch mtime to N minutes ago" — covers BSD/GNU touch + python3 fallback.
set_mtime_minutes_ago() {
  local file="$1" minutes="$2"
  touch -t "$(date -v-"${minutes}"M '+%Y%m%d%H%M.%S' 2>/dev/null || date -d "${minutes} minutes ago" '+%Y%m%d%H%M.%S' 2>/dev/null)" "$file" 2>/dev/null \
    || touch -d "${minutes} minutes ago" "$file" 2>/dev/null \
    || python3 -c "import os, time; os.utime('$file', (time.time()-${minutes}*60, time.time()-${minutes}*60))" 2>/dev/null
}

test_init "test_subagent_detect.sh"

# --- Test 1: CWD inside external worktree layout → subagent ---
assert_subagent \
  "CWD inside ~/Projects/worktrees/beads-task-issue-tracker/<name>/ → subagent" \
  '{"cwd": "/Users/alice/Projects/worktrees/beads-task-issue-tracker/feat-foo", "session_id": "test-external-layout"}'

# --- Test 2: No signals → orchestrator ---
assert_orchestrator \
  "No CWD worktree, no marker, no transcript → orchestrator" \
  '{"cwd": "/Users/alice/Projects/beads-task-issue-tracker", "session_id": "test-no-signals-xyz999"}'

# --- Test 3: Marker file present and fresh → subagent ---
FRESH_SESSION="test-fresh-$$"
FRESH_LOCK="/tmp/claude-subagent-${FRESH_SESSION}.lock"
touch "$FRESH_LOCK"
assert_subagent \
  "Fresh marker file present → subagent" \
  "{\"cwd\": \"/Users/alice/Projects/beads-task-issue-tracker\", \"session_id\": \"${FRESH_SESSION}\"}"
rm -f "$FRESH_LOCK"

# --- Test 4: Marker file older than 30 min → treated as stale → orchestrator ---
STALE_SESSION="test-stale-$$"
STALE_LOCK="/tmp/claude-subagent-${STALE_SESSION}.lock"
touch "$STALE_LOCK"
set_mtime_minutes_ago "$STALE_LOCK" 35
assert_orchestrator \
  "Stale marker file (>30 min) → treated as stale → orchestrator" \
  "{\"cwd\": \"/Users/alice/Projects/beads-task-issue-tracker\", \"session_id\": \"${STALE_SESSION}\"}"
rm -f "$STALE_LOCK"

# --- Test 5: CWD has 'worktrees' substring but NOT as a path component ---
assert_orchestrator \
  "CWD with 'worktrees' as non-path word → orchestrator" \
  '{"cwd": "/Users/alice/my-worktrees-notes/draft", "session_id": "test-false-worktree-xyz"}'

# --- Test 6: Legacy in-repo layout (.worktrees/) → orchestrator (layout removed) ---
assert_orchestrator \
  "Legacy CWD inside <repo>/.worktrees/ → orchestrator (new layout only)" \
  '{"cwd": "/Users/alice/Projects/beads-task-issue-tracker/.worktrees/bd-foo", "session_id": "test-legacy-layout"}'

test_summary
