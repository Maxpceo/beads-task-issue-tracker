---
name: dispatch-supervisor
description: Pi-native supervisor dispatch after an approved plan. Use after plan approval or when user says “запусти supervisor”, “dispatch”, “начни реализацию”.
---

# Dispatch Supervisor

This skill runs only after a bead is claimed and the plan is approved. Approved plan means approved dispatch; do not ask an extra “continue?” question unless there is a real decision point.

## Workflow

1. Guard workflow state:
   ```text
   /workflow-status
   ```
   Required: active bead exists, matches `<ID>`, and state is `plan_approved` or `implementing`. If any other bead is active and non-terminal, stop; if it is `inreview`, continue with `review-bead`.
2. Guard bead:
   ```bash
   bd show <ID> --json
   bd comments <ID> --json
   git branch --show-current
   git rev-parse HEAD
   ```
   Required: status `in_progress`, assignee is this session/user, no unresolved blockers, self-contained handoff sections from `AGENTS.md`, concrete acceptance/verification bullets, labels, and an approved plan comment for non-fast-path work.
3. Approved plan marker: use `PLAN APPROVED` with these fields so `.pi/extensions/beads-dispatch/index.ts` can validate readiness:
   ```text
   PLAN APPROVED
   Approved-by: <user/orchestrator>
   Approved-at: <ISO/date>
   Start-commit: <git sha>
   Problem: <summary>
   Approach: <summary>
   Rejected alternatives: <summary>
   Files to change: <paths>
   Acceptance: <observable checks>
   Verification / acceptance checks: <commands/manual checks>
   ```
   Legacy comments like `PLAN (approved ...)` are not sufficient for typed dispatch unless a compatibility change is intentionally implemented.
4. Call typed tool, not raw subagent:
   ```text
   dispatch_supervisor(beadId=<ID>)
   ```
5. The tool fail-closes readiness, collects cwd branch/start commit, selects agent, logs `DISPATCH` context, and runs the Pi agent. Required prompt fields include `BEAD_ID`, `EPIC_ID`, `BRANCH`, `START_COMMIT`, context summary, approved plan, do-not-guess guidance, over-your-head guidance, and status vocabulary.
6. After supervisor returns, inspect status/report.
7. If completed and bead is `inreview`, record the exact implementation end commit and update state:
   ```bash
   git rev-parse HEAD
   bd comments add <ID> "END_COMMIT: <sha>"
   ```
   ```text
   /workflow-update state=inreview end=<sha>
   ```
8. Continue with `review-bead` automatically; do not start another bead while this one is `inreview`.

## Supervisor selection

Typed dispatch selects the default agent from labels/description/files:

- `frontend` / `ui` / Vue/component/page/composable → `vue-supervisor`;
- `backend` / `tracker` / Rust/Tauri/Cargo → `tauri-supervisor`;
- `ci` / `dx` / tests/workflow/tooling → `test-supervisor`.

If the domain is ambiguous, ask one concrete question with 2-4 options before dispatch.

## Rules

- Do not call raw `subagent` for workflow dispatch.
- Do not dispatch terminal, dependency-blocked, unenriched, unlabeled, unplanned, or vague-acceptance beads; enrich it or ask the user with 2-4 options first.
- Dispatch is required for risky workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain frontend+backend work unless a documented Fast Path/mechanical exception is both narrow and low-risk.
- Do not ask for confirmation after an approved plan unless a real decision point appears.
- If dispatch returns `BLOCKED` or `NEEDS_CONTEXT`, diagnose the missing context before redispatch.
- Supervisor must not close beads, set orchestrator statuses, or push; `beads-policy` enforces this in subagent contexts.
- `land` is not part of supervisor dispatch. It remains an explicit save/push checkpoint requested by the user, while `merge-to-main` is an explicit session-final workflow.

## Final report

| Шаг | Результат |
|---|---|
| Guard | status/assignee/blockers |
| BRANCH | branch |
| START_COMMIT | sha |
| Supervisor | selected agent and reason |
| Dispatch | launched / dry-run / blocked reason |
