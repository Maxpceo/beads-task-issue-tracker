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
   - `inreview` without approval remains open and must be listed;
   - `in_progress` remains open unless the work is explicitly accepted/closed by an allowed fast-path route.
   - Do not use `land` to skip the lifecycle controller: active `inreview` beads still need `review-bead`, and active non-terminal beads block unrelated next work unless explicitly handed off/deferred with reason.
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
6. Commit/sync beads if needed:
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
9. Before terminal bead completion on a pushed feature branch, verify PR/merge evidence:
   ```bash
   git merge-base --is-ancestor HEAD origin/main || gh pr view "$(git branch --show-current)" --json state,mergedAt,url
   ```
   If this is intentionally local-only fast-path/spike work, record an explicit reason in the close command/comment with `PR_MERGED_EXCEPTION=<reason>`, `NO_REMOTE_BRANCH_COMPLETION_REQUIRED`, or `--pr-merged-exception <reason>`.
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
- Do not close remote feature-branch work until merge evidence is recorded, unless a local-only/fast-path exception reason is explicit.
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
| Merge evidence | origin-main ancestor / PR / exception |

If follow-up beads exist, add:

| Bead | Статус | Что |
|---|---|---|
| `<id>` | open/closed | one-line summary |
