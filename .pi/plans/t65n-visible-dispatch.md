# t65n — visible cmux dispatch

DECISION (yys3, Approved-by: Максим):

- Default=interactive cmux; schema/tests may pass transport=headless explicitly; no silent fallback; interactive without cmux = BLOCKED
- Waiter=supervisor ping means «I think my contract is done»; orchestrator runs complete_visible_dispatch; reviewer decides accept/return; no 20-minute hang timer; on-demand watchdog only
- N=one activeBead
- Reviewer=current review_bead (not visible in this epic)
- Isolation=role tools/skills + --no-session

Digest source of truth: `<worktree>/.pi/orchestrator/results/<taskId>.digest`.
HOME ns: registry, kill-handle, orchestrator= pane id only.

## Live smoke (njqr)

CI never live-spawns. Unit (from a worktree with node_modules):
`pnpm exec vitest run tests/extensions/beads-dispatch-cmux.test.ts tests/extensions/beads-dispatch.test.ts`

Fixture bead: `beads-task-issue-tracker-1hy8` (unclaimed, discovered-from t65n). Do not claim it in the njqr implementer session. For the live run, claim it in a separate session, then dispatch.

If `cmux identify --json` fails: ACCEPTANCE MATRIX row Live pane = N/A with the identify output. Not PASS.

If identify succeeds (Maxim present):
1. Task worktree, not main.
2. Claim the fixture in a throwaway session (not the njqr implementer session).
3. `dispatch_supervisor` with `transport=cmux`.
4. One pane on caller workspace.
5. Supervisor ping then `complete_visible_dispatch`.
6. HUMAN ACCEPTANCE comment on njqr: approver: Maxim; reason: pane visible; plus quote.
7. Smoke HA does not close epic t65n.
