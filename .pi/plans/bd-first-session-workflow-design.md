# Bd-first Pi session workflow design

## Status

Design for `beads-task-issue-tracker-76eh`.

Follow-up implementation epic: `beads-task-issue-tracker-r8tj`.

Child implementation beads:

| Bead | Scope |
|---|---|
| `beads-task-issue-tracker-v495` | Convert `.pi/extensions/workflow-state` into a session-context store. |
| `beads-task-issue-tracker-hrtp` | Move `beads-policy` lifecycle decisions to bd status + comments/evidence. |
| `beads-task-issue-tracker-18hd` | Update plan/dispatch/review/workflow-chain integrations. |
| `beads-task-issue-tracker-bmgc` | Update dashboard/footer/session context display. |
| `beads-task-issue-tracker-cg7l` | Update skills/agents/docs/tests. |

## Problem

Pi currently has two lifecycle authorities for the same issue:

1. Durable bd status: `open`, `in_progress`, `inreview`, `simplified`, `reviewed`, `accepted`, `closed`, `blocked`, `deferred`, plus possible custom statuses.
2. Session-local Pi workflow state: `idle`, `claimed`, `planning`, `plan_approved`, `implementing`, `inreview`, `reviewing`, `accepted`, `closed`, `landing`, `merged`, `blocked`, `deferred`.

This creates split-brain behavior. The most visible bug class is status mapping drift: `workflow-state` and `beads-policy` map `reviewed`/`accepted` to `accepted`, while `workflow-chain` maps `reviewed` to `reviewing`. Custom statuses and external bd mutations make the model more fragile.

## Target model

`bd status` is the only authoritative issue lifecycle source.

Pi workflow/session state stores only session binding and execution context:

- `activeBead`
- `branch`
- `worktreePath`
- `startCommit`
- `endCommit`
- `sessionKey`
- `runtimeOwnerKey`
- `planMode`: `off | strict | auto`
- `planApproved`: boolean or timestamp/comment reference
- `mergeSlotHeld`
- optional transient `sessionMode`: examples `idle`, `planning`, `implementing`, `reviewing`, `landing`, `merging`

Lifecycle decisions read bd status and structured bd comments/evidence. Session decisions read Pi session context.

## Non-negotiable guards to preserve

| Guard | Must remain true after migration |
|---|---|
| Review checkpoints | `inreview -> simplified -> reviewed -> accepted -> closed` remains enforced by bd status and comments/evidence. |
| Close evidence | Terminal close requires `accepted`, or documented reviewed/no-acceptance shortcut, or explicit override. Stale Pi state alone is not enough. |
| Supervisor restrictions | Subagents cannot close beads, set orchestrator statuses, or push. |
| Active session bead block | A current-session active bead with non-terminal bd status blocks claiming/dispatching/reviewing unrelated beads. |
| Planning read-only | `planMode=strict|auto` blocks edit/write and mutating bash/bd/git commands. |
| Merge-slot push guard | `git push` still requires merge-slot evidence or session `mergeSlotHeld=true`. |
| Worktree/path safety | Main mutation, protected paths, allowed worktree root, stale worktree guard, and explicit file staging remain enforced. |

## Producers / consumers matrix

| Component | Current producer/consumer behavior | Bd-first behavior |
|---|---|---|
| `.pi/extensions/workflow-state/index.ts` | Former model produced Pi lifecycle state, persisted active bead/session fields, and reconciled via `stateFromBdStatus`. | Produces session context only. Reads bd status for display/recovery, but does not coerce bd lifecycle into Pi lifecycle. Keeps ownership/stale/foreign detection. |
| `.pi/extensions/beads-policy/index.ts` | Former model consumed Pi lifecycle state for active bead blocking, Fast Path supervisor readiness, close allowance, review checkpoint gating, planning, merge-slot. It had separate `workflowStateFromBdStatus`. | Lifecycle guards query bd status + comments. Session guards use active bead/session fields. Planning and merge-slot remain session fields. Remove duplicate lifecycle mapping or make it display-only. |
| `.pi/extensions/plan-mode/index.ts` | Emits `planning`; `/plan-cancel` may emit `idle`; auto approval uses plan mode state. | Emits `planMode` and `planApproved`; optional `sessionMode=planning`. Does not imply issue lifecycle. Bd remains `in_progress` after claim. |
| `.pi/extensions/beads-dispatch/index.ts` | Emits `implementing`/`reviewing`, then reconciles based on bd status after supervisor/reviewer. | Emits session mode/scope only. Supervisor path is allowed by bd active bead + approved plan evidence. Reviewer dispatch remains typed. |
| `.pi/extensions/review-workflow/index.ts` | Requires bd `inreview`, emits Pi `reviewing`/`closed`, drives bd review statuses. | Keeps bd status as hard lifecycle guard. Emits `sessionMode=reviewing` and scope fields. Terminal completion is bd close plus session clear. |
| `.pi/extensions/workflow-chain/index.ts` | Has independent bd-status-to-workflow-state mapping and `requiredState`. | Uses explicit `requiredBdStatus`/`requiredSession` concepts. Typed workflow steps remain handoff-only unless executed by typed tools. |
| `.pi/extensions/status-dashboard.ts` | Reads workflow-state entries and displays `wf:<state>`. | Displays separate `session:<mode> bead:<id> bd:<status> plan:<mode/approved> slot:<state>`. Unknown/custom bd status is displayed as-is. |
| `.pi/extensions/footer-dashboard/index.ts` | Reads workflow-state, hides duplicate status keys, shows active/fallback bead. | Same fallback distinction, but no authoritative `wf:<lifecycle>` field. Current-session vs global fallback remains marked. |
| `.pi/extensions/bead-purpose/index.ts` | Uses active workflow bead to scope purpose. | Uses active session bead and live bd status; does not infer lifecycle from Pi state. |
| `.pi/extensions/follow-up-reminder/index.ts` | Uses workflow/session state for reminders. | Uses active session bead plus bd status to avoid reminders for terminal/foreign work. |
| Skills | Document Pi lifecycle `claimed -> ... -> closed`. | Document bd lifecycle authority and Pi session context/ownership checks. |
| Agents | Depend on workflow prompts for allowed lifecycle transitions. | Agents must report bd status evidence and must not mutate orchestrator-only states unless their contract allows it. |
| Tests | Former coverage encoded Pi lifecycle states as authority. | Cover bd statuses, custom statuses, session ownership, plan mode, merge-slot, review evidence, and dashboard display. |

## Legacy mapping being replaced

Former Pi session-state sequence (kept here only as historical migration input, not authoritative lifecycle): `claimed`, `planning`, `plan_approved`, `implementing`, `inreview`, `reviewing`, `accepted`, `closed`.

Durable review chain in bd:

```text
inreview -> simplified -> reviewed -> accepted -> closed
```

Current problematic mappings:

| bd status | `workflow-state` / `beads-policy` | `workflow-chain` |
|---|---|---|
| `open` | undefined | `claimed` |
| `in_progress` | `implementing` | `implementing` |
| `inreview` | `inreview` | `inreview` |
| `simplified` | undefined | `reviewing` |
| `reviewed` | `accepted` | `reviewing` |
| `accepted` | `accepted` | `accepted` |
| `closed` | `closed` | `closed` |
| `blocked` | `blocked` | `blocked` |
| `deferred` | `deferred` | `deferred` |
| custom/unknown | undefined | undefined |

## New consumer mapping

| Old Pi state use | New source |
|---|---|
| Is there active work in this Pi session? | `activeBead` + `sessionKey`/`runtimeOwnerKey` + branch/worktree/start evidence. |
| Can another bead be claimed? | Active bead bd status is terminal or explicit handoff/deferred; otherwise block. |
| Is plan mode active? | `planMode=strict|auto`. |
| Is a plan approved? | `planApproved` and/or `PLAN APPROVED` bd comment with session evidence. |
| Can supervisor dispatch run? | Active bead matches, bd status is `in_progress`, plan approval evidence exists, session ownership matches. |
| Is review allowed? | bd status is `inreview` or documented resume status for the specific review command, plus branch/worktree/start ownership evidence. |
| Can review checkpoints advance? | Current bd source status + required comments/evidence. |
| Can close run? | bd status `accepted`, or `reviewed` with documented no-acceptance shortcut, or explicit override. |
| Should footer show lifecycle? | Show `bd:<status>` and `session:<mode>` separately. |
| Is push allowed? | `mergeSlotHeld=true` or current bd merge-slot holder evidence. |

## Edge cases and expected behavior

| Edge case | Expected behavior |
|---|---|
| Pi starts idle while bd has unrelated `in_progress` beads | Footer may show fallback marked `*`; no session ownership is assumed. |
| Pi has active session bead but bd status is custom/unknown | Display `bd:<custom>`; block lifecycle-sensitive actions unless policy has explicit safe handling. |
| `simplified` after interrupted review | Resume review only with ownership evidence and review workflow support; do not coerce to `accepted`. |
| `reviewed` without acceptance evidence | Close remains blocked; acceptance step/comment is required unless no-acceptance shortcut is documented. |
| `accepted` while Pi session is idle | Standard close may proceed only if bd status/comments satisfy close evidence; active session is not required for durable close. |
| External bd status change to terminal | Session state is cleared or marked stale; no stale active lifecycle remains. |
| `/plan-cancel` after claim | Clears `planMode`; does not set issue lifecycle to idle. Active bead remains bound until explicit handoff/reset/close. |
| Raw `bd update --claim` | Still blocked in Pi workflow; use `/workflow-claim` or equivalent so session binding is recorded. |
| Supervisor attempts close/status/push | Blocked by policy. |
| Unknown terminal-like custom status | Treat as non-terminal/unknown unless explicitly configured; do not silently allow close/next work. |
| Stale/foreign workflow entry from another branch/worktree | Clear local active bead and require explicit takeover. |
| Multiple Pi sessions on same bead | Require branch/worktree/session evidence before review/dispatch; otherwise ask for takeover. |
| Merge-slot acquired outside Pi | Push guard may accept bd merge-slot holder evidence; footer session slot may remain free. |
| Stacked branch review | `startCommit..endCommit` remains explicit and stored in session comments/state. |

## Phased migration plan

1. **Session contract** (`beads-task-issue-tracker-v495`)
   - Introduce/rename fields for session context and plan approval.
   - Make bd status display/recovery read-only, not lifecycle authority.
   - Preserve ownership/stale/foreign recovery.

2. **Policy contract** (`beads-task-issue-tracker-hrtp`)
   - Refactor active bead, review, close, and Fast Path readiness checks to use bd status + evidence.
   - Keep plan and merge-slot session guards.

3. **Workflow integrations** (`beads-task-issue-tracker-18hd`)
   - Update plan-mode, dispatch, review workflow, and workflow-chain to emit/use session fields.
   - Replace `requiredState` lifecycle gates with bd-status/session requirements.

4. **Display and context** (`beads-task-issue-tracker-bmgc`)
   - Change footer/dashboard copy from `wf:<state>` to separated session/bd fields.
   - Preserve fallback marker semantics.

5. **Docs/tests/skills** (`beads-task-issue-tracker-cg7l`)
   - Update Pi-only docs and skills.
   - Add regression tests and smoke acceptance evidence.

## Compatibility / rollback

- Keep a temporary compatibility adapter that can read old `workflow-state.state` entries, but treat them as session hints only.
- Do not delete old fields until tests and docs have migrated.
- Rollback path: retain current workflow-state entry shape and re-enable old mapping behind a single compatibility helper, while leaving bd status unchanged.
- Migration is safe to phase because bd remains durable source of truth throughout.

## Verification performed for this design

Fresh coverage command used during design:

```bash
grep -R "workflow-state\|workflowState\|plan_approved\|reviewing\|accepted\|stateFromBdStatus\|reconcileWorkflowState" .pi
```

Observed coverage includes:

- `.pi/extensions/workflow-state/index.ts`
- `.pi/extensions/beads-policy/index.ts`
- `.pi/extensions/plan-mode/index.ts`
- `.pi/extensions/beads-dispatch/index.ts`
- `.pi/extensions/review-workflow/index.ts`
- `.pi/extensions/workflow-chain/index.ts`
- `.pi/extensions/status-dashboard.ts`
- `.pi/extensions/footer-dashboard/index.ts`
- `.pi/skills/*/SKILL.md`
- `.pi/plans/pi-native-workflow-migration.md`

## NEXT SESSION HANDOFF

Take implementation epic:

```bash
bd show beads-task-issue-tracker-r8tj --json
bd show beads-task-issue-tracker-v495 --json
```

Recommended first implementation bead: `beads-task-issue-tracker-v495`.
