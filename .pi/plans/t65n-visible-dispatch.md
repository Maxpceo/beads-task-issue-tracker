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

CI never live-spawns. Unit: `pnpm exec vitest run tests/extensions/beads-dispatch-cmux.test.ts tests/extensions/beads-dispatch.test.ts`.

If `cmux identify --json` fails: matrix `N/A` with output. Not PASS.

If identify succeeds (manual, Maxim present):
1. Task worktree, not main.
2. `dispatch_supervisor` with `transport=cmux` on an in_progress bead.
3. One pane on caller workspace.
4. Supervisor ping → `complete_visible_dispatch`.
5. Maxim quote that the pane was visible. Smoke quote does not close the epic.
EOF
