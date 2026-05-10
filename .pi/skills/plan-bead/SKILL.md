---
name: plan-bead
description: Pi-native planning workflow for a claimed bead. Use after claim-bead or when user asks to plan a bead.
---

# Plan Bead

## Workflow

1. Ensure workflow state has `activeBead` and state `claimed` or `planning`:
   ```text
   /workflow-status
   ```
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
   /workflow-update state=plan_approved plan=off
   ```

## Rules

- Planning mode is read-only.
- If requirements are ambiguous, ask a single batched question.
- Edge cases are required for non-trivial work.
