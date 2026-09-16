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
4. Claim and bind session first with `workflow_claim(beadId=<ID>)`; this runs bd claim and records active bead, `sessionMode=claimed`, branch, worktree, and start commit. When cwd is `main`/`master`, claim may auto-discover an existing canonical task worktree for this bead suffix.
5. Worktree matrix after claim (do not re-claim):
   - **Unique already bound:** recorded scope is a canonical task branch/worktree (not `main`/`master`) → skip `bd worktree create` and skip `workflow_update`; continue planning from that lock.
   - **Zero matches / lock still main or empty:** create the worktree before plan approval with the canonical branch naming and worktree naming contract: branch `<type>/<bead-suffix>-<domain-or-component>-<purpose>`, worktree basename exactly `<bead-suffix>-<domain-or-component>-<purpose>`, for example `task/lgok-branch-worktree-naming` plus worktree `lgok-branch-worktree-naming`. Type mapping: bug→`fix`, feature→`feat`, docs-only→`docs`, tests/bench→`test`, CI→`ci`, refactor→`refactor`, workflow/task→`task`, maintenance→`chore`. Use the supported command `bd worktree create <absolute-path> --branch <branch>` from the project checkout; do not recover by suggesting raw `git worktree add` when main-mutation policy is active. Then record the task `worktreePath`/branch/start via `workflow_update(worktree=..., branch=..., start=...)` before `workflow_plan_approved`.
   - **Ambiguous (claim warning lists candidates) or empty claimed scope after list-fail:** do **not** re-claim. Pick one candidate from the warning, then only `workflow_update(worktree=<abs>, branch=<canonical>, start=<HEAD>)`. `workflow_update` remains the typed recovery tool.
   Main checkout remains a normal Pi entrypoint: typed workflow tools route through structured task scope (`workflowState.worktreePath`) even when Pi was started from `main`. Raw mutating shell commands, tests, bd writes, and git operations still must run from the task worktree (or use a supported explicit cwd form); read-only inspection from the main checkout remains allowed.
6. Enter planning with `workflow_plan_mode(mode=strict)` by default, `workflow_plan_mode(mode=auto)` only when the user explicitly requested automatic implementation, or `workflow_plan_mode(mode=autopilot)` when the user requested autonomous work through close (`/plan-autopilot`, «работаю автономно», «работать автономно»). Claim must not clear an already-set autopilot session flag.
7. Continue with `plan-bead`.

Slash commands (`/workflow-status`, `/workflow-claim`, `/workflow-reset`, `/plan`, `/plan-auto`, `/plan-autopilot`) are optional human UI shortcuts, not required agent steps.

## Reporting

Chat for Maxim follows `AGENTS.md`. Auto-continue after a normal claim is silent (no footer dump). Stop only when claim needs Maxim (closed bead, assigned to someone else, stale/foreign ownership, typed tool unavailable, worktree failure): `##` + `## Дальше` with `1/2/3`.

## Rules

- First non-readonly action is `workflow_claim(beadId=<ID>)`. If typed tools are unavailable, stop with `BLOCKED` rather than using raw `bd update --claim` and drifting session state.
- Do not edit files before plan approval/auto gate.
- `land` and `merge-to-main` are explicit session workflows, not prerequisites for claiming the next bead after the previous bead reaches `closed`.
- Fast Path follows `AGENTS.md` risk-aware limits and hard supervisor path rules.
- If the bead is missing handoff context or concrete acceptance, enrich it or ask before implementation/dispatch.
- Do not create follow-up beads from memory-only context; use the full self-contained template from `AGENTS.md`.
- Do not use markdown TODOs; progress is in bd.
