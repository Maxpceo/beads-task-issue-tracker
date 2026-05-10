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
7. If any error happens after acquire, release merge-slot before reporting.
8. Verify:
   ```bash
   git status -sb
   ```

## Rules

- Never use `git add .` or `git add -A`.
- Never say “ready to push”; push.
- Final report is a table with commands, exit codes, commits, and push evidence.
