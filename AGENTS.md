# Agent Instructions

## Pi-native Workflow

For Pi sessions, the source of truth is this `AGENTS.md` file plus `.pi/*`.
`CLAUDE.md` and `.claude/*` are Claude Code workflow references and MUST NOT be modified unless the user explicitly asks for Claude Code workflow changes.

Pi workflow migration plan: `.pi/plans/pi-native-workflow-migration.md`.
Progress is tracked in bd, not as markdown task lists.

## Fast Path / Large Change Discipline

Fast Path is allowed only when the orchestrator explicitly judges the change to be trivial, low-risk, and cheaper than supervisor dispatch.

- Low-risk direct work: up to 3 code files and up to 80 added lines, with clear acceptance evidence.
- Threshold exceeded: continue only with an explicit `FAST_PATH_RATIONALE`/written rationale or switch to supervisor path.
- Hard supervisor path: workflow/policy/review/merge logic, `.pi/agents`, scripts, or cross-domain frontend + backend changes require an active bead and approved plan/supervisor workflow.
- Mechanical batches are allowed only with an explicit mechanical label/reason, narrow scope, and review evidence.
- Docs/beads-only maintenance should not trigger Fast Path blocks, but still needs accurate bd tracking when it creates work.

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:

   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```

5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Self-Contained Beads

Agent-created beads must be self-contained handoff packages. A future session must be able to implement or review the task without chat history.

Required description sections for non-epic, non-exempt agent-created beads:

- `### Origin`
- `### Files`
- `### Current state`
- `### Target state`
- `### Investigation findings`
- `### Decisions`
- `### Rejected alternatives`
- `### Dependencies / blockers`
- `### Acceptance criteria`
- `### Verification / acceptance checks`
- `### Out of scope`

Also required:

- Add at least one label (`--label`, `--labels`, or `-l`).
- Add relationships when known: `parent-child:<epic-id>` for epic children, `discovered-from:<source-id>` for follow-ups, and blocker dependencies for required ordering.
- Acceptance and verification must be observable bullet checks, not vague phrases like “works”, “done”, or “fixed”.
- If acceptance is unclear, stop and ask the user one concrete question with 2-4 options before creating, dispatching, or closing the bead.
- If context is insufficient, investigate first, create a spike, or ask; do not create stub tasks that rely on chat memory.

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" -t bug|feature|task -p 0-4 --label dx --description "$(cat <<'EOF'
### Origin
- Source bead/user request and why this exists.
### Files
- path/to/file.ts
### Current state
- Observable current behavior.
### Target state
- Observable target behavior.
### Investigation findings
- Evidence gathered so far.
### Decisions
- Chosen approach and rationale.
### Rejected alternatives
- Alternative and why rejected.
### Dependencies / blockers
- parent-child:<epic-id> / discovered-from:<id> / blocks:<id> / none.
### Acceptance criteria
- Concrete observable result.
### Verification / acceptance checks
- Command/manual check with expected result.
### Out of scope
- Explicit non-goals.
EOF
)" --json

bd create "Follow-up title" -p 1 --label dx --deps discovered-from:bd-123 --description "$(cat <<'EOF'
### Origin
- Discovered from bd-123.
### Files
- path/to/file.ts
### Current state
- Observable current behavior.
### Target state
- Observable target behavior.
### Investigation findings
- Evidence gathered so far.
### Decisions
- Chosen approach and rationale.
### Rejected alternatives
- Alternative and why rejected.
### Dependencies / blockers
- discovered-from:bd-123.
### Acceptance criteria
- Concrete observable result.
### Verification / acceptance checks
- Command/manual check with expected result.
### Out of scope
- Explicit non-goals.
EOF
)" --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

<!-- END BEADS INTEGRATION -->
