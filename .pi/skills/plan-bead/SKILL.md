---
name: plan-bead
description: Pi-native planning workflow for a claimed bead. Use after claim-bead or when user asks to plan a bead.
---

# Plan Bead

## Workflow

1. Run `workflow_status`. Ensure session context has this `activeBead` and bd status is non-terminal (`in_progress` after claim). If bd status is `inreview`, switch to `review-bead` instead of planning unrelated work.
2. Enter plan mode if not active: `workflow_plan_mode(mode=strict)`, `workflow_plan_mode(mode=auto)` only when explicitly authorized for plan+implement, or `workflow_plan_mode(mode=autopilot)` for autonomous work through code-review/close (`Approved-by: оркестратор`, durable autopilot flag after `plan=off`). `/plan`, `/plan-auto`, and `/plan-autopilot` are optional human UI shortcuts. Do not change `/plan-auto` semantics when using autopilot.
3. Read `bd show <ID>` and `bd comments <ID>` plus relevant files/references.
4. Produce a structured plan. Ask clarifying questions only via the `questionnaire` tool (one question tool — do not invent a second). When the plan is fully ready for Maxim's decision in **strict** plan mode, call `plan_mode_complete({ plan })` as the last tool in the turn so the ready-UI appears (Исполнить / Остаться / Уточнить / Отправить на plan-review). Do **not** call `plan_mode_complete` after a clarifying question. The plan-review ready button is critique only (same as `/plan-review`): it does not write `PLAN APPROVED` and does not start a supervisor. Auto/autopilot paths do not use ready-UI.
5. For auto-execute, include the supervisor-dispatch readiness matrix: `PLAN APPROVED`, `Approved-by:`, `Approved-at:`, `Start-commit:` or `START_COMMIT:`, `Files to change:`, `Acceptance:`, `Verification / acceptance checks:`, and implementation intent via either current `Plan:` or legacy `Problem:` + `Approach:`. Also include the accepted context fields `Problem:`, `Approach:`, `Rejected alternatives:`, `Edge-case review:`, `Worktree / cwd:`, `WORKTREE_LOCK:`, `Risks / rollback:`, and `AUTO_EXECUTE_ALLOWED: true` when applicable. `WORKTREE_LOCK` must name the required task worktree cwd and state that all mutating implementation, tests, bd comments/status updates, git add/commit/push, and typed dispatch/review/docs tools run from that worktree or inside it until explicit `merge-to-main` transitions to `main` after PR merge. If `Worktree / cwd:` names a task worktree, it must already be a readable git worktree on the expected branch before approval; create it first with `bd worktree create <absolute-path> --branch <branch>` rather than raw `git worktree add`.
6. After approval or auto gate, call `workflow_plan_approved(beadId=<ID>, planEvidence=<approved plan text>)`. For autopilot, pass `approvedBy="оркестратор"` (runtime `/plan-autopilot` path does this automatically). This preflights explicit/recorded worktree scope before writing durable `PLAN APPROVED` evidence, then exits plan mode and updates workflow-state in one path; autopilot keeps its session flag after `plan=off`. If it blocks, use its recovery text (`bd worktree create <absolute-path> --branch <branch>` or typed workflow-state recovery) before retrying. Autopilot must not call `land` or `merge-to-main`.

## Reporting

Chat for Maxim follows `AGENTS.md`. Do not announce normal plan-mode or bd-status values the footer already shows. After approval/auto gate, continue silently unless there is a real decision. When strict planning stops for approval, ambiguity, or a block: `##` + `## Дальше` with `1/2/3`.

## Plan-review cycle cap (workflow_plan_review)

Typed `workflow_plan_review` has a hard max of **2 spawns** per plan-mode session (cycle counter persists across turns; reset only when plan mode goes off→on / new `/plan`). `/plan-auto` execution path is separate and not capped by this counter.

Exclusive stop advice from `planReviewStopAdvice` (risk is telemetry only and never changes advice):

| Condition | Advice |
|---|---|
| `!gateOk` (missing/blocked reviewer or unresolved blockers) | `HARD_BLOCK` |
| `gateOk` and no important/critical findings | `STOP_SHOW_USER` (from cycle ≥ 1; clean APPROVED / minor-only does **not** force a second spawn) |
| `gateOk` and important/critical remain and `cycle < 2` | `CONTINUE` |
| `gateOk` and `cycle >= 2` | `STOP_SHOW_USER` (show Maxim; no third cycle) |

Orchestrator behavior:

- On `CONTINUE`: revise the draft, then call `workflow_plan_review` again.
- On `STOP_SHOW_USER`: present the plan to Maxim; **MUST NOT call workflow_plan_review** again this planning session. Remaining important/critical findings stay visible for Maxim.
- On `HARD_BLOCK`: do not approve/execute; fix blockers; one retry is allowed while `cycle < 2`.
- Empty `draftPlan` does not increment the cycle counter.
- Failed spawn still consumes a cycle slot (reserved before `await`).

`classifyPlanReviewRisk` is telemetry only (`low` requires `FAST_PATH_RATIONALE:` plus no `.pi/extensions|skills|agents|rules` / `scripts/` and not both `app/` + `src-tauri`; else `high`). Risk never changes stop advice and never auto-approves.

## Rules

- Planning mode is read-only.
- bd status is the lifecycle authority. Do not plan another bead before the current-session active bead has terminal bd status (`closed`, `blocked`, or explicit `deferred`/handoff).
- If requirements or acceptance are ambiguous, ask a single batched question with 2-4 concrete options and stop until answered.
- Plans must preserve self-contained handoff context: problem, approach, rejected alternatives, files, acceptance, and verification evidence.
- Bead/plan `### Verification / acceptance checks` must list only gate-executable or gate-mapped commands (`pnpm test`/`vitest`, `vue-tsc`, `cargo check`, `git diff --name-only`, `git diff --check`, safe `rg`/`grep`). Manual/live/prose checks belong in Acceptance criteria or IMPLEMENTATION evidence, not Verification bullets for `review_bead` matrix.
- Follow-up beads created during planning must use the full `AGENTS.md` template, labels, and known dependencies.
- Decide Fast Path explicitly; risky workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain work requires approved plan/supervisor path unless a documented exception applies. Plan-review stop advice does not use Fast Path risk to bypass `HARD_BLOCK` or to auto-approve.
- Edge cases are required for non-trivial work.
- Non-trivial plans (anything beyond tiny, low-risk Fast Path work) must include a `Parallel Decomposition Matrix` before approval. For Russian-language beads/plans (default in this project), use human-readable Russian headings: `Поток`, `Цель`, `Агент`, `Зона изменений`, `Зависимости`, `Проверка`, `Решение`, `Причина`. Keep the workflow term `Parallel Decomposition Matrix`. Headings map to technical fields `Stream`, `Goal`, `Agent`, `Write zone`, `Dependencies`, `Verification`, `Decision`, `Reason`: `Поток`/`Цель` selects the work package, `Агент` selects the supervisor type, `Зона изменений` scopes file ownership, `Зависимости` orders streams, `Проверка` defines evidence, `Решение` says `parallel` or `sequential`, and `Причина` explains the routing decision. Do not show English-only column headers to Максим unless he explicitly asks for English.
- Fast Path exception: simple/trivial work may omit the matrix only when the plan includes `FAST_PATH_RATIONALE:` with why direct execution is lower-risk/cheaper than supervisor dispatch, expected touched files/line budget, and focused verification. Workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain work still requires approved plan/supervisor path unless the exception is explicit.
- Sequential streams are allowed only with one of these reason classes: dependency chain, write conflict, shared verification bottleneck, shared external resource, uncertain scope, or repo/policy limit. Vague reasons such as “files are related”, “same area”, or “related changes” are not accepted. Keep technical values `parallel` / `sequential` and reason-class identifiers in English even when the table headers/content are Russian.

## Parallel Decomposition Matrix example

| Поток | Цель | Агент | Зона изменений | Зависимости | Проверка | Решение | Причина |
|---|---|---|---|---|---|---|---|
| A | Обновить planning contract в `plan-bead` | docs/workflow supervisor | `.pi/skills/plan-bead/SKILL.md` | нет | `rg "Parallel Decomposition Matrix" .pi/skills/plan-bead/SKILL.md` | parallel | независимая зона изменений и docs-only проверка |
| B | Добавить `plan-review` guard и focused tests | test/DX supervisor | `.pi/extensions/plan-review/index.ts`, `tests/extensions/plan-review.test.ts` | нет | `pnpm exec vitest run tests/extensions/plan-review.test.ts --reporter dot` | parallel | независимая зона изменений и focused test verification |
| C | Синхронизировать `plan-mode` fixture после guard | test/DX supervisor | `tests/extensions/plan-mode.test.ts` | B | `pnpm exec vitest run tests/extensions/plan-mode.test.ts --reporter dot` | sequential | dependency chain: `plan-mode` fixture использует поведение `plan-review` guard из потока B |
