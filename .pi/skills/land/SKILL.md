---
name: land
description: Pi-native landing workflow. Use when user says “пора заканчивать”, “push всё”, “сохрани работу”, “landing the plane”.
---

# Land

`land` is an explicit user-triggered save/push checkpoint for the current feature branch. It is not an automatic per-task stage and is not required after a bead reaches `closed`. `merge-to-main` is the later explicit PR → merge → checkout main workflow.

## Workflow

1. Inspect state, preferably in one compact command:
   ```bash
   git status --short
   git branch --show-current
   bd list --status=in_progress
   bd list --status=inreview
   ```
2. File follow-up beads for remaining work using the full `AGENTS.md` template. Track every follow-up bead created in this session for the final report.
3. Resolve session beads before push:
   - `inreview` with `CODE REVIEW: APPROVED` and acceptance evidence may be closed by the orchestrator;
   - if the user explicitly accepts completed/inreview work with phrases such as “завершай”, “закрывай”, “принято”, “всё ок”, or “accepted”, treat it as human acceptance: record acceptance evidence/comment when needed, run `workflow_update(bead=<ID>, session=accepted)`, close via standard `bd close`, then run `workflow_complete(state=closed, reason=<bead closed>)` or reset to idle;
   - `inreview` without approval or human acceptance remains open and must be listed;
   - `in_progress` remains open unless the work is explicitly accepted/closed by an allowed fast-path route.
   - Do not use `land` to skip bd lifecycle authority: current-session active beads with bd status `inreview` still need `review-bead` or explicit human acceptance, and active non-terminal bd statuses block unrelated next work unless explicitly handed off/deferred with reason.
4. Run quality gates if code changed:
   ```bash
   pnpm test && npx vue-tsc --noEmit
   ```
   For docs/beads-only changes, record `not run: docs/beads only` rather than implying tests passed.
5. Commit code with explicit paths only:
   ```bash
   git add <files>
   git commit -m "<message>"
   ```
6. Commit/sync beads if needed. After a human-accepted bead close, run `bd dolt push` so the close state is not stranded locally:
   ```bash
   bd dolt pull || true
   bd dolt push || true
   ```
   If this project is in legacy JSONL mode, commit `.beads/` explicitly with named paths.
7. Acquire merge-slot and push:
   ```bash
   bd merge-slot acquire
   git pull --rebase
   git push
   bd merge-slot release
   ```
8. If any error happens after acquire, release merge-slot before reporting.
9. Do not require merge evidence for per-task bead close. `land` is only a save/push checkpoint; session-final merge evidence belongs to explicit `merge-to-main`.
10. Verify final pushed state:
   ```bash
   git status -sb
   git log --oneline -3
   ```

## Rules

- Never use `git add .` or `git add -A`.
- Never say “ready to push”; push during this workflow.
- Do not run `land` automatically after every bead; after `closed`, the next bead may be claimed without a push checkpoint unless the user asks to save/push.
- Merge-slot serializes pushes between parallel sessions. Do not run `git push` if `bd merge-slot acquire` failed.
- Do not treat `land` as merge completion. Per-task bead close may happen before merge; session-final merge evidence is recorded by explicit `merge-to-main`.
- Evidence before claims: final report must include commands, exit codes, commits, push evidence, and PR/merge evidence or exception reason.
- If follow-up beads were created during this session, list them even if already closed.

## Final report

| Шаг | Результат |
|---|---|
| Commits | sha list / not required |
| Quality gates | command + exit code / skipped reason |
| Push | OK / not required |
| Closed beads | IDs / — |
| Open session beads | IDs and reason / — |
| Follow-up beads | count / — |
| Save evidence | pushed branch / not required |

If follow-up beads exist, add:

| Bead | Статус | Что |
|---|---|---|
| `<id>` | open/closed | one-line summary |
