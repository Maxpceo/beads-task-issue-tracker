---
name: land
description: Pi-native landing workflow. Use when user says “пора заканчивать”, “push всё”, “сохрани работу”, “landing the plane”.
---

# Land

Work is not complete until `git push` succeeds.

## Workflow

1. Inspect state:
   ```bash
   git status --short
   git branch --show-current
   bd list --status=in_progress
   bd list --status=inreview
   ```
2. File follow-up beads for remaining work.
3. Run quality gates if code changed:
   ```bash
   pnpm test && npx vue-tsc --noEmit
   ```
4. Commit code with explicit paths only:
   ```bash
   git add <files>
   git commit -m "<message>"
   ```
5. Commit beads if needed:
   ```bash
   bd dolt commit -m "sync beads"
   ```
6. Acquire merge-slot and push:
   ```bash
   bd merge-slot acquire
   git pull --rebase
   bd dolt pull || true
   bd dolt push || true
   git push
   bd merge-slot release
   ```
7. Before terminal bead completion on a pushed feature branch, verify PR/merge evidence:
   ```bash
   git merge-base --is-ancestor HEAD origin/main || gh pr view "$(git branch --show-current)" --json state,mergedAt,url
   ```
   If this is intentionally local-only fast-path/spike work, record an explicit reason in the close command/comment with `PR_MERGED_EXCEPTION=<reason>`, `NO_REMOTE_BRANCH_COMPLETION_REQUIRED`, or `--pr-merged-exception <reason>`.
8. If any error happens after acquire, release merge-slot before reporting.
9. Verify:
   ```bash
   git status -sb
   ```

## Rules

- Never use `git add .` or `git add -A`.
- Never say “ready to push”; push.
- Do not close remote feature-branch work until merge evidence is recorded, unless a local-only/fast-path exception reason is explicit via `PR_MERGED_EXCEPTION=<reason>`, `NO_REMOTE_BRANCH_COMPLETION_REQUIRED`, or `--pr-merged-exception <reason>`.
- Final report is a table with commands, exit codes, commits, push evidence, and PR/merge evidence or exception reason.
