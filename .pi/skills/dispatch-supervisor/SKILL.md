---
name: dispatch-supervisor
description: Pi-native supervisor dispatch after an approved plan. Use after plan approval or when user says “запусти supervisor”, “dispatch”, “начни реализацию”.
---

# Dispatch Supervisor

This skill runs only after a bead is claimed and the plan is approved. Approved plan means approved dispatch; do not ask an extra “continue?” question unless there is a real decision point.

## Workflow

1. Guard session context and bd status:
   ```text
   workflow_status
   ```
   Required: current-session active bead exists, matches `<ID>`, bd status is `in_progress`, and session context shows an approved plan (`planApproved=true` or `sessionMode=plan_approved/implementing`). If any other current-session active bead has non-terminal bd status, stop; if bd status is `inreview`, continue with `review-bead`.
2. Guard bead:
   ```bash
   bd show <ID> --json
   bd comments <ID> --json
   git branch --show-current
   git rev-parse HEAD
   ```
   Required: status `in_progress`, assignee is this session/user, no unresolved blockers, self-contained handoff sections from `AGENTS.md`, concrete acceptance/verification bullets, labels, and an approved plan comment for non-fast-path work.
3. Approved plan marker: use `PLAN APPROVED` with the same readiness matrix as `.pi/extensions/beads-dispatch/index.ts`:
   ```text
   PLAN APPROVED
   Approved-by: <user/orchestrator>
   Approved-at: <ISO/date>
   Start-commit: <git sha> # or START_COMMIT: <git sha>
   Files to change: <paths>
   Plan: <implementation steps> # or legacy Problem: + Approach:
   Problem: <summary>
   Approach: <summary>
   Rejected alternatives: <summary>
   Edge-case review: <edge cases>
   Worktree / cwd: <path>
   WORKTREE_LOCK: <mutation scope>
   Acceptance: <observable checks>
   Verification / acceptance checks: <commands/manual checks>
   Risks / rollback: <risks and rollback>
   AUTO_EXECUTE_ALLOWED: true
   ```
   Required readiness fields are the marker, approval metadata, start commit, files, acceptance, verification, and implementation intent (`Plan:` or `Problem:` + `Approach:`). The other listed fields are accepted context fields and should stay synchronized with `plan-bead`. Legacy comments like `PLAN (approved ...)` are not sufficient for typed dispatch.
4. Call typed tool, not raw subagent:
   ```text
   dispatch_supervisor(beadId=<ID>)
   # optional explicit override when needed: dispatch_supervisor(beadId=<ID>, cwd=<workflowState.worktreePath>)
   ```
5. The tool fail-closes readiness, resolves structured task scope from workflow-state, routes to `workflowState.worktreePath` in main-start sessions, collects task-worktree branch/start commit, selects agent, logs `DISPATCH` context, and runs the Pi agent. If an explicit `cwd` is passed, policy requires it to be inside the active task worktree. Required prompt fields include `BEAD_ID`, `EPIC_ID`, `BRANCH`, `START_COMMIT`, context summary, approved plan, do-not-guess guidance, over-your-head guidance, and status vocabulary.
6. After supervisor returns, inspect status/report.
7. If completed and bead is ready for review, use the typed transition guard instead of raw `bd update --status inreview` when available:
   ```bash
   git rev-parse HEAD
   bd comments add <ID> "END_COMMIT: <sha>"
   ```
   ```text
   workflow_submit_for_review(beadId=<ID>, reason=<fresh evidence summary>, endCommit=<sha>)
   ```
   This synchronizes `bdStatus=inreview` with `state/sessionMode=inreview`, preserves the task branch/worktree/start scope recorded in workflow-state, and writes durable `WORKFLOW SUBMIT FOR REVIEW` evidence for main-start review routing. If a supervisor used raw bd update, immediately repair the session with `workflow_update(bead=<ID>, state=inreview, session=inreview, branch=<branch>, worktree=<task-worktree>, start=<sha>, end=<sha>)` before any final report.
8. Continue with `review-bead` automatically; do not start another bead or stop with a normal final report while this one is `inreview`. If review cannot run, return an explicit `BLOCKED` report with the blocker and exact next action.

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

## Reporting

Use a full `Где мы в workflow` block for `BLOCKED`, `NEEDS_CONTEXT`, failed guards, unavailable review path, required policy/context decisions, and final dispatch summaries. Do not print routine guard/pass or footer-state checkpoints while continuing automatically from dispatch to review.

## Final report

| Шаг | Результат |
|---|---|
| Guard | status/assignee/blockers |
| BRANCH | branch |
| START_COMMIT | sha |
| Supervisor | selected agent and reason |
| Dispatch | launched / dry-run / blocked reason |
