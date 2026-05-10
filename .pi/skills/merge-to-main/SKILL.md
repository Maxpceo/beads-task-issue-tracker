---
name: merge-to-main
description: Pi-native merge workflow. Use when user says “мержим”, “создай PR”, “merge to main”, “давай PR”.
---

# Merge to Main

Full explicit PR + docs + merge cycle for a feature branch. Do not run `land` before this skill; merge-to-main includes commit/push. This workflow is user-triggered session-final work, not an automatic per-task lifecycle stage.

## Workflow

1. Pre-flight:
   ```bash
   git status --short
   git branch --show-current
   git log --oneline main..HEAD
   bd list --status=in_progress
   bd list --status=inreview
   ```
2. If on `main`, stop: nothing to merge.
3. Resolve feature-related open beads only. Treat unrelated beads from parallel sessions as background; do not block on them. Any session-active bead on this branch must be terminal (`closed`, `blocked`, or explicit `deferred`/handoff with reason) before merging.
4. Commit dirty feature-branch files with explicit paths. Commit bead metadata separately if needed.
5. Run quality gates:
   ```bash
   pnpm test && npx vue-tsc --noEmit
   ```
6. Push branch via merge-slot:
   ```bash
   bd merge-slot acquire
   git pull --rebase
   git push -u origin "$(git branch --show-current)"
   bd merge-slot release
   ```
   If any error happens after acquire, release merge-slot before reporting.
7. Create PR with `gh pr create`.
8. Dispatch docs agent if user-facing changes require docs:
   ```text
   dispatch_docs_agent(beadId=<ID>)
   ```
   Documentation can be skipped only for internal/config/test-only changes or explicit user request.
9. Wait for CI when checks exist. Do not merge with failing checks.
10. Merge PR via merge-slot. If acquire fails, stop before `gh pr merge`:
    ```bash
    bd merge-slot acquire
    gh pr merge <PR_NUMBER> --merge --delete-branch
    ```
    If merge fails after acquire, release merge-slot before reporting.
11. Switch to main, pull, and release slot:
    ```bash
    git checkout main
    git pull origin main
    bd merge-slot release
    ```
    If checkout or pull fails, release merge-slot before reporting. The workflow is not complete while the current session remains on the merged feature branch.
12. Verify clean/up-to-date state and session-scoped artifact cleanup.

## Final verdict: can this Pi session close?

The final line of the merge report must answer whether the current Pi session can be closed. Scope the verdict to artifacts created or claimed by this session only; ignore unrelated worktrees, branches, and beads from parallel sessions.

Track session artifacts during the workflow:

- session beads: beads claimed or created by this Pi session;
- session branches: branches created or used for this merge by this Pi session;
- session worktrees: worktrees created by this Pi session;
- session commits: commits authored/landed by this Pi session.

Run these checks before the final verdict:

```bash
echo "=== current branch ==="; git branch --show-current
echo "=== dirty ==="; git status --short
echo "=== merge-slot ==="; bd show beads-task-issue-tracker-merge-slot 2>&1 | grep -E "Status|holder" || true
# For each session bead: bd show <ID> must be closed, or explicitly left open in the report.
# For each session branch: git branch --list <branch> should be empty after PR merge/delete.
# For each session worktree: git worktree list | grep <path> should be empty after cleanup.
# For each session commit: git merge-base --is-ancestor <commit> origin/main must exit 0.
```

Conditions for `session can close`:

1. Current branch is `main`.
2. Working tree is clean.
3. Merge-slot is not held by this session.
4. Session commits are ancestors of `origin/main`.
5. Session branches and worktrees were removed or explicitly documented as intentionally retained.
6. Session beads are closed, or any intentionally open bead is listed with the exact reason.

Final report format:

| Шаг | Результат |
|---|---|
| Commit | `<sha>` or not required |
| Push | OK / not required |
| PR | `#N` URL |
| Docs | updated / skipped with reason |
| CI | PASS / skipped with reason |
| Merge | merge commit / evidence |
| Branch | `main`, `<sha>` |
| Session artifacts | cleaned / blockers listed |

The last line must be exactly one of these forms:

```markdown
✅ Сессию можно закрывать — работа этой сессии в main, артефакты убраны.
```

```markdown
⚠️ Сессию НЕ закрывать: <session-scoped blocker>; <session-scoped blocker>
```

## Rules

- `main` is read-only for ordinary agent edits/commits. Any main-branch mutation in this workflow must happen only after PR merge/checkout as part of the approved merge flow; do not make ad-hoc fixes on `main`.
- Terminal completion of pushed feature-branch work requires merged PR/origin-main ancestry evidence; otherwise use an explicit `PR_MERGED_EXCEPTION=<reason>`, `NO_REMOTE_BRANCH_COMPLETION_REQUIRED`, or `--pr-merged-exception <reason>` only for local-only fast-path or spike work.
- Do not report merge completion until checkout/pull main and final verdict checks have run.
- `land` remains optional/manual; never require it as a pre-step before merge-to-main.
- Final report is a two-column table plus the mandatory final verdict line.
