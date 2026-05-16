# Plan Mode Extension

Project-local Pi plan mode adapted for the beads workflow.

## Features

- Read-only exploration mode via `/plan` or clear natural-language activation phrases.
- Auto-execute mode via `/plan-auto` with a required multi-agent plan-review gate before implementation.
- Agent-operable `workflow_plan_review` typed tool for autonomous strict plan mode.
- Tool restriction to read-only tools while planning.
- Bash allowlist for read-only commands.
- bd-aware allowlist/blocklist:
  - allowed: `bd show`, `bd comments`, `bd list`, `bd ready`, selected read-only `bd dep`/`bd dolt` commands;
  - blocked: `bd create`, `bd update`, `bd close`, mutating comments, merge-slot acquire/release, Dolt commit/push/pull.
- Plan extraction from numbered `Plan:` / `Revised plan:` sections.
- Execution progress via `[DONE:n]` markers.
- Session persistence.

## Commands

- `/plan` — toggle strict plan mode. User approval is required before execution.
- `/plan-auto` — enter plan mode and auto-execute only after required plan-review agents run and the revised plan passes the gate.
- `/plan-cancel` — cancel plan mode and restore normal tools.
- `/plan-review` — run required plan-review agents against the latest draft plan without approving or executing it.
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

## Multi-agent auto-execute gate

`/plan-auto` is only for cases where the user explicitly requested “plan and then implement”. It does not execute the first draft plan. Instead:

1. The main agent produces a draft plan in read-only plan mode.
2. Pi runs required project-local plan reviewers:
   - `plan-edge-reviewer`
   - `plan-consistency-reviewer`
   - `plan-dead-zone-reviewer`
3. Reviewers return structured `PLAN REVIEW: APPROVED | NEEDS_CHANGES | BLOCKED` findings.
4. The main agent must analyze findings and produce a revised plan.
5. Auto-execute starts only if the revised plan contains all required sections and `Unresolved blockers: none`.

Required revised-plan sections:

```markdown
Reviewer findings summary:
- Summary of reviewer verdicts and important findings

Accepted findings:
- Finding accepted and concrete plan change

Rejected findings:
- Finding rejected and reason, or none

Unresolved blockers: none

Revised plan:
1. First step
2. Second step

Files to change:
- path/to/file: intended change

Acceptance:
- Command/check and expected result

Risks / rollback:
- Risk and rollback strategy

AUTO_EXECUTE_ALLOWED: true
```

If any reviewer is missing, fails, returns `BLOCKED`, or reports unresolved blockers, auto-execute is blocked and the session remains in plan mode/read-only.

## Strict plan critique

Strict `/plan` remains manual: it never auto-executes. When the user explicitly asks to check the current plan with agents (or runs `/plan-review`), Pi runs the same required reviewers against the latest draft plan and prints findings without mutating files, bd status, workflow approval state, or leaving plan mode. The user must still approve execution explicitly.

Autonomous planning agents should use the typed `workflow_plan_review` tool instead of relying on slash/input triggers. The tool accepts the complete `draftPlan`, runs the required reviewers, and returns structured gate details plus rendered reviewer output. It does not write files, mutate bd, approve the plan, acquire/release merge-slot, change git state, or leave plan mode. If a reviewer is missing, fails, returns `BLOCKED`, or reports unresolved blockers, the tool returns `ok: false` and the agent must keep implementation blocked.

## Responsibility split

This extension owns real plan-mode behavior: tool access, read-only command gates, plan extraction, and plan execution. It also emits `workflow-state:update` events so `.pi/extensions/workflow-state` keeps session fields synchronized while bd remains lifecycle authority:

- `/plan` or a supported natural-language activation phrase -> `plan=strict`, `sessionMode=planning`
- `/plan-auto` -> `plan=auto`, `sessionMode=planning`
- `/plan-cancel` -> `plan=off` and `sessionMode=idle` when the current session is still planning
- executing an approved plan -> `plan=off`, `planApproved=true`, and `sessionMode=implementing` when the current session is still planning

The `workflow-state` extension stores session context such as active bead, branch, worktree, merge-slot hint, plan approval, review/acceptance session mode, landing, and idle reset. It displays live `bdStatus`, but bd remains the source of truth for bead lifecycle.
