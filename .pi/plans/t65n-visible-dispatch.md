# t65n — visible cmux dispatch

DECISION (yys3, Approved-by: Максим):

- Default=interactive cmux; schema/tests may pass transport=headless explicitly; no silent fallback; interactive without cmux = BLOCKED
- Waiter=supervisor ping means «I think my contract is done»; orchestrator runs complete_visible_dispatch; reviewer decides accept/return; no 20-minute hang timer; on-demand watchdog only
- N=one activeBead
- Reviewer=current review_bead (not visible in this epic)
- Isolation=role tools/skills + --no-session

Digest source of truth: `<worktree>/.pi/orchestrator/results/<taskId>.digest`.
HOME ns: registry, kill-handle, orchestrator= pane id only.
EOF
