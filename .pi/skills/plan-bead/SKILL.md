---
name: plan-bead
description: Pi-native planning workflow for a claimed bead. Use after claim-bead or when user asks to plan a bead.
---

# Plan Bead

## Workflow

1. Ensure session context has this `activeBead` and bd status is non-terminal (`in_progress` after claim):
   ```text
   /workflow-status
   ```
   Treat `sessionMode`/`state` as a session hint only. If context shows another current-session active bead with a non-terminal bd status, stop and continue that bead. If bd status is `inreview`, switch to `review-bead` instead of planning unrelated work.
2. Enter plan mode if not already active:
   - `/plan` for strict approval.
   - `/plan-auto` only when the user explicitly authorized automatic execution.
3. Read context:
   ```bash
   bd show <ID>
   bd comments <ID>
   ```
4. Read relevant files and references.
5. Produce a structured plan.
6. For auto-execute, include all required sections:
   - `Plan:`
   - `Edge-case review:`
   - `Files to change:`
   - `Acceptance:`
   - `Risks / rollback:`
   - `AUTO_EXECUTE_ALLOWED: true`
7. After approval or auto gate, save a PLAN comment:
   ```bash
   bd comments add <ID> "PLAN (approved YYYY-MM-DD): ..."
   ```
8. Update state:
   ```text
   /workflow-update session=plan_approved approved=true plan=off
   ```

## Rules

- Planning mode is read-only.
- bd status is the lifecycle authority. Do not plan another bead before the current-session active bead has terminal bd status (`closed`, `blocked`, or explicit `deferred`/handoff). `sessionMode` values such as `planning` or `plan_approved` only describe this Pi session's phase.
- If requirements or acceptance are ambiguous, ask a single batched question with 2-4 concrete options and stop until answered.
- Plans must preserve self-contained handoff context: problem, approach, rejected alternatives, files, acceptance, and verification evidence.
- New or follow-up beads created during planning must use the full template from `AGENTS.md`, include labels, and link `parent-child`, `discovered-from`, or blocker dependencies when known.
- Decide Fast Path explicitly: direct implementation is only for trivial low-risk work (≤3 code files and ≤80 added lines). Risky workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain frontend+backend work requires approved plan/supervisor path unless it is a tiny docs-only change.
- Edge cases are required for non-trivial work.
