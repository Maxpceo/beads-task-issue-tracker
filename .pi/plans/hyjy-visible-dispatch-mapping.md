# hyjy — mapping Orchestra → beads dispatch

Spike bead: `beads-task-issue-tracker-hyjy`.
Verified spawn: **unverified, mock only** until a live `cmux identify` probe fills the subsection below.

## Problem this spike solves

Headless `dispatch_supervisor` is a dark window. Maxim needs to see one supervisor in a cmux pane. Parallel **beads** in one orchestrator session stay out of scope. Parallel **panes for one bead** is designed in the registry so we do not rewrite later.

## Copy-from (read-only)

| Haasbot | Beads adaptation |
|---|---|
| `~/Projects/Haasbot/agents/run.sh` | `.pi/orchestrator/run.sh` |
| `~/Projects/Haasbot/agents/ping.sh` | `.pi/orchestrator/ping.sh` |
| `~/Projects/Haasbot/agents/lib.sh` | `.pi/orchestrator/lib.sh` |
| `~/Projects/Haasbot/agents/pi-role.sh` | `.pi/orchestrator/pi-role.sh` |
| Haasbot HTML board, MCP slices, `orchestra/models.conf` | **do not copy** |
| Haasbot `PROJ=.../Haasbot`, `ORCH_ROOT=$PROJ/.pi/orchestrator` | `ORCH_ROOT=${ORCH_ROOT:-$HOME/.pi/orchestrator}` |
| Haasbot `orch_resolve_ns` via `CMUX_SURFACE_ID` + `cmux tree` | one `cmux identify --json`; fail-close if missing |
| Haasbot `new-split` + send + enter (cmux 0.64.22, no `--command`) | **cmux adapter (scripts):** same split+send until verified otherwise |
| Haasbot interactive `pi` without `--tools`/`--no-session` | **script spawn (B/D):** interactive TUI so Maxim can intervene. **typed builder (C):** isolated argv, mocked cmux |

Do not `source` Haasbot paths from beads scripts.

## Rewrite table

| Symbol | Beads value |
|---|---|
| `ORCH_ROOT` | `$HOME/.pi/orchestrator` (override in tests) |
| Runtime ns | `$ORCH_ROOT/ns/<workspace-uuid>/` |
| In-repo `.pi/orchestrator/` | scripts only |
| In-repo `.pi/orchestrator/ns/` | gitignored, defensive |
| `CMUX` | `cmux` on PATH, else `/Applications/cmux.app/Contents/Resources/bin/cmux` |
| Identify | `cmux identify --json` once per spawn |
| Task id | synthetic `taskId` in registry (not a second bead id) |
| poll.sh id | registry `taskId` |
| watchdog.sh id | registry `taskId` or pane ref |

## Two spawn layers

1. **Pi child argv (fail-close, unit-tested)**
   - Required: `--append-system-prompt`, `--tools`
   - Session: `--no-session` **or** explicit throwaway `--session <dir>`
   - `--tools` from agent frontmatter; default `read,bash,edit,write`
   - Prompt body lives in `$NS_DIR/tasks/<taskId>.md` plus `$NS_DIR/prompts/<taskId>.md`
   - Isolation files are deleted only on pane kill/tombstone. Spawn-ack and typed-tool abort must **not** unlink them while the registry entry is live.
2. **cmux transport adapter**
   - Candidate (unpinned): `cmux identify` → `cmux new-split right` → `cmux send` with `\n` Enter in the same send (Haasbot lesson; do not send-key separately).
   - Do **not** fail-close on cmux `--command`. Pin here after one live probe.

### Verified spawn

`cmux identify --json` from the hyjy worktree (2026-09-13) succeeded (exit 0). Payload uses `caller.workspace_ref` (`workspace:6`), not a UUID. `lib.sh` sanitizes that to `workspace-6`.

Live smoke (HUMAN ACCEPTANCE, Maxim: «Панель вижу»):
- `cmux new-split right --surface surface:26` → `OK surface:135 workspace:6`
- Adapter: split + `cmux send ...\n` (not `--command`)
- Child Pi v0.85.1 / kimi-for-coding ran the smoke prompt, wrote digest ≤5 lines
- `poll.sh hyjy-smoke` exit 0; `watchdog.sh hyjy-smoke` status=alive, hang file 3342 bytes
- No bd comments on hyjy; no repo edits by the child
- Rollback: `cmux close-surface --surface surface:135`

## Orchestra protocol → our contract

| Orchestra | Beads |
|---|---|
| `tasks/NNN.md` | `$NS_DIR/tasks/<taskId>.md` written by orchestrator/scripts |
| `results/NNN.md` + digest ≤10 lines | `$NS_DIR/results/<taskId>.md` and `$NS_DIR/results/<taskId>.digest` |
| `ping.sh` → orchestrator pane | `.pi/orchestrator/ping.sh` (notify/flash; no bd status) |
| HTML board | **out of scope** (Maxim 2026-09-11) |
| `panes.env` | `$NS_DIR/panes.env` plus `$NS_DIR/dispatch-registry.json` |
| Headless wait | default `transport=headless` still `await runPiAgent` |
| Visible spawn | `transport=cmux` spawn-ack only |

## Who writes bd comments

| Event | Writer |
|---|---|
| Default headless dispatch | wrapper `DISPATCH (` then later `DISPATCH RESULT` / maybe `WORKFLOW SUBMIT FOR REVIEW` |
| `transport=cmux` spawn-ack | **nobody**. No `DISPATCH (`, no RESULT, no inreview, no workflow-state implementing/review |
| Visible-path completion | out of scope for auto-submit. One-shot `poll.sh` reads digest. Orchestrator may later write RESULT **not in this spike on hyjy** |
| `requestSupervisorDispatch` | always headless; never passes `transport=cmux` |

Spawn-ack ≠ DONE. Workflow-chain must not treat spawn-ack as supervisor complete.

## Poll / watchdog (no busy-wait)

- Tool returns spawn-ack and **stops**.
- Completeness: Maxim prompt **or** `.pi/orchestrator/poll.sh <taskId>` (digest ≤10 lines, not full result/screen).
- Hang facts: `.pi/orchestrator/watchdog.sh <taskId>` → `$NS_DIR/hang/<taskId>.txt` with capped `read-screen --lines 20`.
- `scheduler_create` default **off**.
- Never auto-redispatch. After two hang/false-complete cycles stop and ask Maxim.

## N-registry vs single activeBead

- `workflow-state.activeBead` stays **one bead per orchestrator session**.
- `dispatch-registry.json` is an N-map of panes for **transport**, not a second lifecycle authority.
- Required N-proof: this paragraph + vitest dummy entries. Live N=1.
- Concurrent two-bead implementation in one session: **out of scope**. Do not weaken `validateSupervisorPreflight`.

Registry fields: `taskId`, `beadId`, `pane`, `worktree`, `role`, `model`, `taskFile`, `resultFile`, `digestFile`, `promptFile`, `status`, `createdAt`.

Order: create pane → persist registry (kill handle) → spawn-ack.
Failure before registry: best-effort pane kill + tombstone, then error.
Abort after spawn-ack: do **not** reap pane; registry is the kill handle.
Successful live smoke: leave pane+ns, print rollback, stop for Maxim.

## Guard conflicts

| Guard | Visible transport | Proposed later (not this spike) |
|---|---|---|
| `activeBead === beadId` | keep; typed cmux still requires it; live smoke uses scripts + synthetic taskId | queue of dispatches owned by orchestrator |
| START_COMMIT freshness | keep on default path | visible waiter after child commit |
| Plan mode | unchanged | n/a |
| Hash / review runtime | unchanged; 79w0 still per review | per-pane later |
| Worktree lock | scripts cwd = task worktree; runtime ns is `$HOME/.pi/orchestrator` | n/a |
| Merge-slot | unchanged; parallel land still queues | n/a |
| Wrapper auto-submit | **disabled** on cmux branch | attach waiter later without dropping completeness checks |

## Hang playbook

1. `watchdog.sh <taskId>` writes capped screen excerpt to hang file.
2. If pane dead: prune registry, tombstone, do not redispatch.
3. If pane alive but silent: record facts, notify Maxim, stop after two cycles.
4. Rollback: close pane via registry kill handle; delete `$NS_DIR` entry; no scheduler jobs by default.

## Out of scope

Production headless replacement; visible `dispatch_reviewer`; HTML board; Haasbot MCP; auto `WORKFLOW SUBMIT FOR REVIEW` on visible path; two beads in one session; live typed `transport=cmux` as hyjy acceptance; closing sota.

## Executor for this spike

Parent/orchestrator implements in `task/hyjy-pi-dispatch-visible-cmux`. Typed `dispatch_supervisor` of hyjy is **not** used (circular: the work *is* dispatch). `FAST_PATH_RATIONALE`: circularity, not cheapness.
