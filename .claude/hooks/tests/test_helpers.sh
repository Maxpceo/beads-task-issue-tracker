#!/bin/bash
#
# test_helpers.sh — shared assertion helpers for hook unit tests.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/test_helpers.sh"
#   test_init "suite_name"
#   pass "description"
#   fail "description" "details"
#   test_summary    # exits 0 if all passed, 1 otherwise
#

PASS=0
FAIL=0
SUITE_NAME=""

test_init() {
  SUITE_NAME="$1"
  PASS=0
  FAIL=0
  echo "=== $SUITE_NAME ==="
}

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  local description="$1"
  local details="${2:-}"
  echo "  FAIL: $description"
  [[ -n "$details" ]] && echo "        $details"
  FAIL=$((FAIL + 1))
}

test_summary() {
  echo ""
  echo "$SUITE_NAME: $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
}
