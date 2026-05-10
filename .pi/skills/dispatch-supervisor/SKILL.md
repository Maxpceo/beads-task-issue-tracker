---
name: dispatch-supervisor
description: Pi-native supervisor dispatch after an approved plan. Use after plan approval or when user says “запусти supervisor”, “dispatch”, “начни реализацию”.
---

# Dispatch Supervisor

## Workflow

1. Guard workflow state:
   ```text
   /workflow-status
   ```
   Required: active bead exists and state is `plan_approved` or `implementing`.
2. Guard bead:
   ```bash
   bd show <ID> --json
   bd comments <ID> --json
   ```
   Required: status `in_progress`, no unresolved blockers, self-contained handoff sections from `AGENTS.md`, concrete acceptance/verification bullets, labels, and a `PLAN APPROVED` comment for non-fast-path work.
3. Call typed tool, not raw subagent:
   ```text
   dispatch_supervisor(beadId=<ID>)
   ```
4. The tool fail-closes readiness, collects cwd branch/start commit, selects agent, logs DISPATCH comment, and runs the Pi agent.
   Required prompt fields: `BEAD_ID`, `EPIC_ID`, `BRANCH`, `START_COMMIT`, context summary, approved plan, do-not-guess guidance, over-your-head guidance, and status vocabulary.
5. After supervisor returns, inspect status/report.
6. If completed and bead is `inreview`, update state:
   ```text
   /workflow-update state=inreview
   ```
7. Continue with `review-bead`.

## Rules

- Do not call raw `subagent` for workflow dispatch.
- Do not dispatch terminal, dependency-blocked, unenriched, unlabeled, unplanned, or vague-acceptance beads; enrich it or ask the user with 2-4 options first.
- Dispatch is required for risky workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain frontend+backend work unless a documented Fast Path/mechanical exception is both narrow and low-risk.
- Do not ask for confirmation after an approved plan unless a real decision point appears.
- If dispatch returns BLOCKED/NEEDS_CONTEXT, diagnose before redispatch.
