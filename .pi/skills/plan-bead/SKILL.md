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
5. For auto-execute, include: `Plan:`, `Edge-case review:`, `Files to change:`, `Acceptance:`, `Risks / rollback:`, and `AUTO_EXECUTE_ALLOWED: true`.
6. After approval or auto gate, call `workflow_plan_approved(beadId=<ID>, planEvidence=<approved plan text>)`. This writes `PLAN APPROVED` evidence, exits plan mode, and updates workflow-state in one path.

## Reporting

Plan and approval reports must include `Где мы в workflow` with:

- `Текущий этап`: planning / plan approved / blocked.
- `Стоп или продолжаю`: stop for user approval in strict mode, or continue automatically only when auto mode/user approval allows it.
- `Причина`: cite plan mode, bd status, missing context, or approval evidence.
- `Следующий шаг`: approve plan, dispatch supervisor, or ask the exact clarification.
- `Действие Максима`: the concrete approval/choice required, or `не требуется` after approval.

## Rules

- Planning mode is read-only.
- bd status is the lifecycle authority. Do not plan another bead before the current-session active bead has terminal bd status (`closed`, `blocked`, or explicit `deferred`/handoff).
- If requirements or acceptance are ambiguous, ask a single batched question with 2-4 concrete options and stop until answered.
- Plans must preserve self-contained handoff context: problem, approach, rejected alternatives, files, acceptance, and verification evidence.
- Follow-up beads created during planning must use the full `AGENTS.md` template, labels, and known dependencies.
- Decide Fast Path explicitly; risky workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain work requires approved plan/supervisor path unless a documented exception applies.
- Edge cases are required for non-trivial work.
