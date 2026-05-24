---
name: plan-bead
description: Pi-native planning workflow for a claimed bead. Use after claim-bead or when user asks to plan a bead.
---

# Plan Bead

## Workflow

1. Run `workflow_status`. Ensure session context has this `activeBead` and bd status is non-terminal (`in_progress` after claim). If bd status is `inreview`, switch to `review-bead` instead of planning unrelated work.
2. Enter plan mode if not active: `workflow_plan_mode(mode=strict)`, or `workflow_plan_mode(mode=auto)` only when explicitly authorized. `/plan` and `/plan-auto` are optional human UI shortcuts.
3. Read `bd show <ID>` and `bd comments <ID>` plus relevant files/references.
4. Produce a structured plan.
5. For auto-execute, include the supervisor-dispatch readiness matrix: `PLAN APPROVED`, `Approved-by:`, `Approved-at:`, `Start-commit:` or `START_COMMIT:`, `Files to change:`, `Acceptance:`, `Verification / acceptance checks:`, and implementation intent via either current `Plan:` or legacy `Problem:` + `Approach:`. Also include the accepted context fields `Problem:`, `Approach:`, `Rejected alternatives:`, `Edge-case review:`, `Worktree / cwd:`, `WORKTREE_LOCK:`, `Risks / rollback:`, and `AUTO_EXECUTE_ALLOWED: true` when applicable. `WORKTREE_LOCK` must name the required task worktree cwd and state that all mutating implementation, tests, bd comments/status updates, git add/commit/push, and typed dispatch/review/docs tools run from that worktree or inside it until explicit `merge-to-main` transitions to `main` after PR merge. If `Worktree / cwd:` names a task worktree, it must already be a readable git worktree on the expected branch before approval; create it first with `bd worktree create <absolute-path> --branch <branch>` rather than raw `git worktree add`.
6. After approval or auto gate, call `workflow_plan_approved(beadId=<ID>, planEvidence=<approved plan text>)`. This preflights explicit/recorded worktree scope before writing durable `PLAN APPROVED` evidence, then exits plan mode and updates workflow-state in one path. If it blocks, use its recovery text (`bd worktree create <absolute-path> --branch <branch>` or typed workflow-state recovery) before retrying.

## Reporting

Use a full `Где мы в workflow` block when strict planning stops for user approval, requirements are ambiguous, or planning is blocked. Do not announce normal plan-mode or bd-status values that the footer already shows. After approval/auto gate, continue silently to the next approved workflow step unless there is a real decision point.

## Rules

- Planning mode is read-only.
- bd status is the lifecycle authority. Do not plan another bead before the current-session active bead has terminal bd status (`closed`, `blocked`, or explicit `deferred`/handoff).
- If requirements or acceptance are ambiguous, ask a single batched question with 2-4 concrete options and stop until answered.
- Plans must preserve self-contained handoff context: problem, approach, rejected alternatives, files, acceptance, and verification evidence.
- Follow-up beads created during planning must use the full `AGENTS.md` template, labels, and known dependencies.
- Decide Fast Path explicitly; risky workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain work requires approved plan/supervisor path unless a documented exception applies.
- Edge cases are required for non-trivial work.
- Non-trivial plans (anything beyond tiny, low-risk Fast Path work) must include a `Parallel Decomposition Matrix` before approval. Required columns: `Stream`, `Goal`, `Agent`, `Write zone`, `Dependencies`, `Verification`, `Decision`, `Reason`. These fields must map directly to the supervisor execution contract: stream/goal selects the work package, agent selects the supervisor type, write zone scopes file ownership, dependencies order streams, verification defines evidence, decision says `parallel` or `sequential`, and reason explains the routing decision.
- Fast Path exception: simple/trivial work may omit the matrix only when the plan includes `FAST_PATH_RATIONALE:` with why direct execution is lower-risk/cheaper than supervisor dispatch, expected touched files/line budget, and focused verification. Workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain work still requires approved plan/supervisor path unless the exception is explicit.
- Sequential streams are allowed only with one of these reason classes: dependency chain, write conflict, shared verification bottleneck, shared external resource, uncertain scope, or repo/policy limit. Vague reasons such as “files are related”, “same area”, or “related changes” are not accepted.

## Parallel Decomposition Matrix example

| Stream | Goal | Agent | Write zone | Dependencies | Verification | Decision | Reason |
|---|---|---|---|---|---|---|---|
| A | Update plan-bead planning contract docs | docs/workflow supervisor | `.pi/skills/plan-bead/SKILL.md` | none | `rg "Parallel Decomposition Matrix" .pi/skills/plan-bead/SKILL.md` | parallel | independent write zone and docs-only verification |
| B | Add plan-review guard and focused tests | test/DX supervisor | `.pi/extensions/plan-review/index.ts`, `tests/extensions/plan-review.test.ts` | none | `pnpm exec vitest run tests/extensions/plan-review.test.ts --reporter dot` | parallel | independent write zone and focused test verification |
| C | Align plan-mode fixture after guard exists | test/DX supervisor | `tests/extensions/plan-mode.test.ts` | B | `pnpm exec vitest run tests/extensions/plan-mode.test.ts --reporter dot` | sequential | dependency chain: plan-mode fixture consumes the plan-review guard behavior from stream B |
