# Plan Mode Extension

Project-local Pi plan mode adapted for the beads workflow.

## Features

- Read-only exploration mode via `/plan`.
- Auto-execute mode via `/plan-auto` with a required plan quality gate.
- Tool restriction to read-only tools while planning.
- Bash allowlist for read-only commands.
- bd-aware allowlist/blocklist:
  - allowed: `bd show`, `bd comments`, `bd list`, `bd ready`, selected read-only `bd dep`/`bd dolt` commands;
  - blocked: `bd create`, `bd update`, `bd close`, mutating comments, merge-slot acquire/release, Dolt commit/push/pull.
- Plan extraction from numbered `Plan:` sections.
- Execution progress via `[DONE:n]` markers.
- Session persistence.

## Commands

- `/plan` — toggle strict plan mode. User approval is required before execution.
- `/plan-auto` — enter plan mode and auto-execute only if the final plan passes the quality gate.
- `/plan-cancel` — cancel plan mode and restore normal tools.
- `/todos` — show current plan progress.
- `Ctrl+Alt+P` — toggle strict plan mode.

## Auto-execute quality gate

`/plan-auto` is only for cases where the user explicitly requested “plan and then implement”. The final planning response must include all sections below:

```markdown
Plan:
1. First step
2. Second step

Edge-case review:
- Edge case and mitigation

Files to change:
- path/to/file: intended change

Acceptance:
- Command/check and expected result

Risks / rollback:
- Risk and rollback strategy

AUTO_EXECUTE_ALLOWED: true
```

If any section is missing, auto-execute is blocked and the session remains in plan mode.

## Responsibility split

This extension controls only plan-mode tool access and plan execution. It does not own bead lifecycle state; that will be handled by the planned `workflow-state` extension.
