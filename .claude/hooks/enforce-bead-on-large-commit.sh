#!/bin/bash
#
# PreToolUse:Bash — Enforce bead workflow on large commits
#
# Problem: Orchestrator can bypass ALL protective hooks by editing code
# directly (without dispatching a supervisor). Hooks on Task and bd close
# never fire if neither tool is used.
#
# Solution: Check at git commit time. If the staged diff is large
# (>1 code file or >20 added lines) and no bead is in_progress,
# emit a soft reminder. This catches the gap where orchestrator
# does Supervisor-Path-level work without following the workflow.
#
# This is a SOFT reminder (does not block), because there are
# legitimate cases (e.g., test files, config) where direct edits are OK.
#

INPUT=$(cat)

# Only check Bash commands containing "git commit"
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -z "$COMMAND" ] && exit 0
echo "$COMMAND" | grep -qE 'git\s+commit' || exit 0

# Skip if this is a beads-only commit (sync beads)
echo "$COMMAND" | grep -qE 'sync beads' && exit 0

# Get list of staged code files (exclude .beads/, .claude/, .md, .json, .jsonl)
CODE_FILE_LIST=$(git diff --cached --name-only 2>/dev/null | grep -vE '^\.(beads|claude)/' | grep -vE '\.(md|json|jsonl)$' || true)

# No code files staged — nothing to check (config/docs only)
[ -z "$CODE_FILE_LIST" ] && exit 0

CODE_FILES=$(echo "$CODE_FILE_LIST" | wc -l | tr -d ' ')

# Count added lines ONLY in code files
ADDED_LINES=0
for f in $CODE_FILE_LIST; do
  lines=$(git diff --cached --numstat -- "$f" 2>/dev/null | awk '{print $1}')
  ADDED_LINES=$((ADDED_LINES + ${lines:-0}))
done

# Fast Path threshold: 1 code file AND <=20 added lines
if [ "$CODE_FILES" -le 1 ] && [ "$ADDED_LINES" -le 20 ]; then
  exit 0
fi

# Large change detected — check if there's a bead in_progress
IN_PROGRESS=$(bd list --status=in_progress 2>/dev/null | grep -cE '[A-Za-z0-9_-]+-[A-Za-z0-9._]+' || true)

if [ "$IN_PROGRESS" -gt 0 ]; then
  # There's a bead in_progress — check if commit message references it
  BEAD_IDS=$(bd list --status=in_progress 2>/dev/null | grep -oE '[A-Za-z0-9_-]+-[A-Za-z0-9._]+' || true)

  # Check if any bead ID appears in the commit command
  FOUND_REF="false"
  for BID in $BEAD_IDS; do
    if echo "$COMMAND" | grep -q "$BID"; then
      FOUND_REF="true"
      break
    fi
  done

  if [ "$FOUND_REF" = "true" ]; then
    # Bead referenced in commit — all good
    exit 0
  fi
fi

# Large commit without bead workflow — emit reminder
cat << EOF
<system-reminder>
LARGE COMMIT WITHOUT BEAD WORKFLOW DETECTED

Staged: ${CODE_FILES} code file(s), ~${ADDED_LINES} added lines.
This exceeds Fast Path limits (1 file, <=20 lines).

Per CLAUDE.md, large changes require Supervisor Path:
1. bd create / bd update --claim
2. Dispatch supervisor (Task tool)  →  supervisor sets --status inreview
3. Dispatch code-simplifier          →  orchestrator sets --status simplified
4. Code review (MANDATORY)           →  orchestrator sets --status reviewed
5. Acceptance                         →  orchestrator sets --status accepted
6. bd close

If this is intentional (e.g., spec tests, config), proceed.
Otherwise, consider following the full workflow.

Current in_progress beads: $(bd list --status=in_progress 2>/dev/null | grep -oE '[A-Za-z0-9_-]+-[A-Za-z0-9._]+' | tr '\n' ', ' || echo "none")
</system-reminder>
EOF

exit 0
