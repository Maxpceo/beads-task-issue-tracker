# Plan Mode Extension

Project-local Pi plan mode adapted for the beads workflow.

## Features

- Read-only exploration mode via `/plan` or clear natural-language activation phrases.
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

## Natural-language activation

Clear requests to enter plan mode are handled like `/plan` and activate strict plan mode without sending the phrase to the agent. Supported phrase families include:

- Russian: `перейди в режим планирования`, `введи в режим планирования`, `переведи меня в режим планирования`, `включи режим планирования`, `активируй режим планирования`, `сделай в режиме планирования`.
- English: `enter plan mode`, `switch to plan mode`, `go to plan mode`, `enable plan mode`, `activate plan mode`, `put me into plan mode`.

Combined workflow requests with an explicit bead id are parsed by intent signals rather than exact full phrases. If a message contains one bead id, a claim/start verb, and a plan intent, Pi claims the bead and then enters strict plan mode before the agent sees the prompt. Examples:

- `beads-task-issue-tracker-zzkb возьми эту задачу в работу, выполняй в режиме планирования`
- `заклейми beads-task-issue-tracker-zzkb, делай в режиме планирования`
- `claim beads-task-issue-tracker-zzkb and plan first`

Safety guards intentionally do not auto-run workflow mutations for questions, negated commands, multiple bead ids, missing bead ids, or examples inside fenced code blocks. Informational or ambiguous prompts continue as normal user input, for example: `что такое режим планирования?`, `можно ли взять beads-task-issue-tracker-zzkb в режим планирования?`, `what is plan mode?`.

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

This extension owns real plan-mode behavior: tool access, read-only command gates, plan extraction, and plan execution. It also emits `workflow-state:update` events so `.pi/extensions/workflow-state` keeps session fields synchronized while bd remains lifecycle authority:

- `/plan` or a supported natural-language activation phrase -> `plan=strict`, `sessionMode=planning`
- `/plan-auto` -> `plan=auto`, `sessionMode=planning`
- `/plan-cancel` -> `plan=off` and `sessionMode=idle` when the current session is still planning
- executing an approved plan -> `plan=off`, `planApproved=true`, and `sessionMode=implementing` when the current session is still planning

The `workflow-state` extension stores session context such as active bead, branch, worktree, merge-slot hint, plan approval, review/acceptance session mode, landing, and idle reset. It displays live `bdStatus`, but bd remains the source of truth for bead lifecycle.
