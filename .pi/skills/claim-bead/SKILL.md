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
4. Leftover plan mode: if plan mode is already on, snapshot the current mode (`strict` / `auto` / `autopilot`), call `workflow_plan_mode(mode=off)` before claim, then after bind re-enter that same mode (including `autopilot`). Do not default leftover autopilot back to strict.
5. Claim and bind session with `workflow_claim(beadId=<ID>)`; this runs bd claim and records active bead, `sessionMode=claimed`, and `PI_SESSION_KEY`. Claim from a protected `main`/`master` checkout does **not** record BRANCH/WORKTREE/START_COMMIT as task scope unless claim auto-discovers a unique canonical task worktree for this bead suffix.
6. Unconditional create/bind before workflow_plan_mode for every claimed bead that will reach `workflow_plan_approved`, including docs/chore/ci (not only bug/feature/task). Unconditional means every issue type with no user-requested gate; it does **not** mean always run `bd worktree create`. Three-outcome bind:
   - **Unique already bound:** recorded task worktree/branch is already the canonical path for this bead → skip create; keep the bound path.
   - **Missing / empty / main:** recorded worktree is missing, empty, or still the main/master checkout → create the canonical task worktree, run setup, then `workflow_update` with the task `worktreePath`/branch/start so the main lock is replaced **before** step 7 plan mode.
   - **Ambiguous:** more than one candidate or unclear ownership of an existing path → `workflow_update` only with the chosen safe binding; do **not** re-claim and do **not** create a second worktree.
   Canonical branch naming and worktree naming contract: branch `<type>/<bead-suffix>-<domain-or-component>-<purpose>`, worktree basename exactly `<bead-suffix>-<domain-or-component>-<purpose>`, for example `task/lgok-branch-worktree-naming` plus worktree `lgok-branch-worktree-naming`. Type mapping: bug→`fix`, feature→`feat`, docs-only→`docs`, tests/bench→`test`, CI→`ci`, refactor→`refactor`, workflow/task→`task`, maintenance→`chore`. On the missing/empty/main path use the supported command `bd worktree create <absolute-path> --branch <branch>` from the project checkout (absolute path required; basename must match the branch suffix so policy does not block create); do not recover by suggesting raw `git worktree add` when main-mutation policy is active. Then run `setup-worktree.sh` and `workflow_update` with the new task worktree/branch/start. Main checkout remains a normal Pi entrypoint: typed workflow tools route through structured task scope (`workflowState.worktreePath`) even when Pi was started from `main`. Raw mutating shell commands, tests, bd writes, and git operations still must run from the task worktree (or use a supported explicit cwd form); read-only inspection from the main checkout remains allowed.
7. Enter planning with `workflow_plan_mode(mode=strict)` by default, `workflow_plan_mode(mode=auto)` only when the user explicitly requested automatic implementation, or `workflow_plan_mode(mode=autopilot)` when the user requested autonomous work through close (`/plan-autopilot`, «работаю автономно», «работать автономно»). After a leftover-plan-mode snapshot from step 4, re-enter that same mode instead of forcing the default. Claim must not clear an already-set autopilot session flag. Never enter plan mode while recorded task worktree is still missing/empty after a main claim.
8. Continue with `plan-bead`.

Slash commands (`/workflow-status`, `/workflow-claim`, `/workflow-reset`, `/plan`, `/plan-auto`, `/plan-autopilot`) are optional human UI shortcuts, not required agent steps.

## Reporting

Chat for Maxim follows `AGENTS.md`. Auto-continue after a normal claim is silent (no footer dump). Stop only when claim needs Maxim (closed bead, assigned to someone else, stale/foreign ownership, typed tool unavailable, worktree failure): `##` + `## Дальше` with `1/2/3`.

## Rules

- First non-readonly action is `workflow_claim(beadId=<ID>)`, except turning leftover plan mode off first when step 4 applies. If typed tools are unavailable, stop with `BLOCKED` rather than using raw `bd update --claim` and drifting session state.
- Do not edit task files before plan approval/auto gate. Required pre-plan bind is **not** a task-file edit: `bd worktree create`, `setup-worktree.sh`, and `workflow_update` (worktree/branch/start) before plan mode are mandatory session bind steps.
- `land` and `merge-to-main` are explicit session workflows, not prerequisites for claiming the next bead after the previous bead reaches `closed`.
- Fast Path follows `AGENTS.md` risk-aware limits and hard supervisor path rules.
- If the bead is missing handoff context or concrete acceptance, enrich it or ask before implementation/dispatch.
- Do not create follow-up beads from memory-only context; use the full self-contained template from `AGENTS.md`.
- Do not use markdown TODOs; progress is in bd.
