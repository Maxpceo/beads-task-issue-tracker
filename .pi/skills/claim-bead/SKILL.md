---
name: claim-bead
description: Pi-native claim-first workflow. Use when the user says “возьми <ID>”, “делай <ID>”, “claim <ID>”, “начни задачу”, or asks to start a bead.
---

# Claim Bead

## Goal

Claim first, then plan. Do not investigate deeply before claiming.

## Workflow

1. Run `workflow_status`. Treat bd status as lifecycle authority and Pi workflow-state as session-local context. If another current-session active bead has a non-terminal bd status, stop. If ownership is stale, foreign, or ambiguous, call `workflow_reset` or ask for explicit takeover confirmation. If confirmed bd status is `inreview`, run `review-bead` next.
2. Read `bd show <ID> --json`.
3. If closed, stop and propose a follow-up bead. If assigned to someone else, ask before stealing.
4. Claim and bind session with `workflow_claim(beadId=<ID>)`; this runs bd claim and records active bead, `sessionMode=claimed`, branch, worktree, and start commit.
5. If the user requested a worktree, create it with an absolute external path and run setup. Record the task `worktreePath`/branch/start in workflow-state. Main checkout remains a normal Pi entrypoint: typed workflow tools route through structured task scope (`workflowState.worktreePath`) even when Pi was started from `main`. Raw mutating shell commands, tests, bd writes, and git operations still must run from the task worktree (or use a supported explicit cwd form); read-only inspection from the main checkout remains allowed.
6. Enter planning with `workflow_plan_mode(mode=strict)` by default, or `workflow_plan_mode(mode=auto)` only when the user explicitly requested automatic implementation.
7. Continue with `plan-bead`.

Slash commands (`/workflow-status`, `/workflow-claim`, `/workflow-reset`, `/plan`, `/plan-auto`) are optional human UI shortcuts, not required agent steps.

## Reporting

Use a full `Где мы в workflow` block only when claim stops or needs Maxim's decision (closed bead, assigned to someone else, stale/foreign ownership, typed tool unavailable, worktree failure). Do not report routine claim/worktree/plan-mode state that is already visible in the footer when continuing automatically.

## Rules

- First non-readonly action is `workflow_claim(beadId=<ID>)`. If typed tools are unavailable, stop with `BLOCKED` rather than using raw `bd update --claim` and drifting session state.
- Do not edit files before plan approval/auto gate.
- `land` and `merge-to-main` are explicit session workflows, not prerequisites for claiming the next bead after the previous bead reaches `closed`.
- Fast Path follows `AGENTS.md` risk-aware limits and hard supervisor path rules.
- If the bead is missing handoff context or concrete acceptance, enrich it or ask before implementation/dispatch.
- Do not create follow-up beads from memory-only context; use the full self-contained template from `AGENTS.md`.
- Do not use markdown TODOs; progress is in bd.
