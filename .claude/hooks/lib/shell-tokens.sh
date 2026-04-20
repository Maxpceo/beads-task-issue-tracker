#!/bin/bash
#
# lib/shell-tokens.sh — Shared helper for shell-token-aware command matching
#
# Usage:
#   source "$CLAUDE_PROJECT_DIR/.claude/hooks/lib/shell-tokens.sh"
#   command_contains_token "$COMMAND" "git[[:space:]]+push"  # returns 0=match, 1=no-match
#
# Approach:
#   1. Strip single-quoted strings ('...')   via sed -E "s/'[^']*'//g"
#   2. Strip double-quoted strings ("...")   via sed -E 's/"[^"]*"//g'
#   3. Grep for pattern with shell-boundary anchors so the token must appear
#      as an actual command (at line start, or after ; & | space), not as an
#      argument embedded in a word.
#
# Known limitation:
#   Escaped quotes \" inside a double-quoted string are NOT handled — the sed
#   strip stops at the first unescaped " and may leave partial content. In
#   practice, hook patterns avoid such constructs. Document this if a future
#   edge case arises.
#

command_contains_token() {
  local cmd="$1"
  local pattern="$2"

  # Collapse newlines → spaces so multiline quoted strings (open on line 1,
  # close on line N) are treated as a single shell command.  This is
  # necessary because sed -E processes line-by-line: a pattern like
  # '"[^"]*"' cannot cross newlines, leaving trigger tokens visible in the
  # unstripped middle lines.
  #
  # tr '\n' ' ' is portable (POSIX, BSD + GNU), changes nothing for the
  # match/no-match decision — only the diagnostic output loses newlines, but
  # command_contains_token returns exit code only.
  #
  # Then strip single- and double-quoted strings, and match at a
  # shell-token boundary (start/whitespace/; & |).
  printf '%s' "$cmd" \
    | tr '\n' ' ' \
    | sed -E -e "s/'[^']*'//g" -e 's/"[^"]*"//g' \
    | grep -qE "(^|[[:space:];&|])${pattern}([[:space:]]|;|&|\||$)"
}
