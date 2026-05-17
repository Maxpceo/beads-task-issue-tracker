---
name: merge-to-main
description: Pi-native merge workflow. Use when user says “мержим”, “создай PR”, “merge to main”, “давай PR”.
---

# Merge to Main

Full explicit PR + docs + merge cycle for a feature branch. Do not run `land` before this skill; merge-to-main includes commit/push. This workflow is user-triggered session-final work, not an automatic per-task bd-status stage.

## Workflow

1. Start in the feature/task worktree when `workflowState.worktreePath` is present. The approved main checkout/pull phase begins only after PR merge; before that, mutating commands, docs dispatch, tests, commit, and branch push run from the feature worktree.
2. Pre-flight:
   ```bash
   git status --short
   git branch --show-current
   git log --oneline main..HEAD
   bd list --status=in_progress
   bd list --status=inreview
   ```
2. If on `main`, stop: nothing to merge.
3. Resolve feature-related open beads only. Treat unrelated beads from parallel sessions as background; do not block on them. Any session-active bead on this branch must have terminal bd status (`closed`, `blocked`, or explicit `deferred`/handoff with reason) before merging; Pi session fields are context, not lifecycle authority.
4. For each session bead being merged, inspect bd comments for the latest `ACCEPTANCE MATRIX:` or a valid `HUMAN ACCEPTANCE OVERRIDE` with `approver:` and `reason:`. The merge report must include a concise acceptance coverage table. If a session bead has `FAIL`, `NOT RUN`, `BLOCKED`, or `SCOPE GAP` without valid override, stop before PR/merge.
4.1. Если проблемы нашли после закрытия bead в merge-to-main, и надо сделать мелкий scoped fix на той же ветке:
- Добавьте marker в comments закрытого bead:
  ```text
  POST-CLOSE MERGE FIX
  BRANCH: <current branch>
  WORKTREE: <current worktree>
  START_COMMIT: <git rev-parse HEAD>
  REASON: <кратко зачем правка нужна для merge quality gate>
  ```
- Сделайте только строго scoped фиксы на той же `BRANCH/WORKTREE` в этом `START_COMMIT` контексте и запишите отдельный `MERGE FIX`/`ACCEPTANCE` комментарий с результатом запуска `pnpm test && npx vue-tsc --noEmit` после правки.
- Без такого marker новые risky-изменения в `.pi/extensions` / `workflow` на уже закрытом bead блокируются.
5. Commit dirty feature-branch files with explicit paths. Commit bead metadata separately if needed.
6. Run quality gates:
   ```bash
   pnpm test && npx vue-tsc --noEmit
   ```
7. Push branch via merge-slot:
   ```bash
   bd merge-slot acquire
   git pull --rebase
   git push -u origin "$(git branch --show-current)"
   bd merge-slot release
   ```
   If any error happens after acquire, release merge-slot before reporting.
8. Create PR with `gh pr create`.
9. Dispatch docs agent for documentation coverage before merge:
   ```text
   dispatch_docs_agent(beadId=<ID>, cwd=<feature-worktree-path>)
   ```
   The docs agent must inspect the branch diff and handle CHANGELOG/README/docs coverage during this merge workflow, not during `land`:
   - for code changes, update `CHANGELOG.md` under `[Unreleased]` or record an explicit skip reason;
   - for user-facing behavior/setup/API changes, update `README.md` or `docs/` as needed;
   - CHANGELOG/README entries must be written in English.
   Documentation can be skipped only for internal/config/test-only changes, workflow-only changes, or explicit user request, and the skip reason must be recorded in the merge report.
10. Wait for CI when checks exist. Do not merge with failing checks.
11. Merge PR via merge-slot. If acquire fails, stop before `gh pr merge`:
    ```bash
    bd merge-slot acquire
    gh pr merge <PR_NUMBER> --merge --delete-branch
    ```
    If merge fails after acquire, release merge-slot before reporting.
12. Switch to main, pull, and release slot:
    ```bash
    git checkout main
    git pull origin main
    bd merge-slot release
    ```
    If checkout or pull fails, release merge-slot before reporting. The workflow is not complete while the current session remains on the merged feature branch.
13. Verify clean/up-to-date state and session-scoped artifact cleanup.

## Final verdict: can this Pi session close?

The final line of the merge report must answer whether the current Pi session can be closed. Scope the verdict to artifacts created or claimed by this session only; ignore unrelated worktrees, branches, and beads from parallel sessions.

Classify final-state evidence before writing the verdict:

- session-scoped blockers: artifacts created, claimed, or intentionally reused by this merge session that still need cleanup or verification;
- unrelated parallel checkout state: branches, dirty files, worktrees, or beads that belong to another session/agent and appeared independently of this merge after the session commits were landed.

Unrelated parallel checkout state can be mentioned in the report as background context, but it must not change a successful session-scoped verdict into `⚠️ Сессию НЕ закрывать`. Keep the verdict strict for this session's artifacts only. If a dirty file, non-main branch, open bead, retained worktree, or missing branch cleanup belongs to this merge session, it remains a blocker.

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

1. Current branch is `main`, unless the checkout has already been reused by unrelated parallel activity after this session's merge completed; in that case, document the unrelated branch and keep evaluating the session artifacts below.
2. Working tree is clean for this session's files; unrelated dirty files from parallel activity are background context, not a session blocker.
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
| Docs | CHANGELOG/README/docs updated or skipped with explicit reason |
| Acceptance coverage | matrix summary / override with approver+reason / blocker |
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
- Per-task bead close can happen before merge in multi-task sessions; session-final completion requires merged PR/origin-main ancestry evidence in this workflow.
- Do not report merge completion until checkout/pull main and final verdict checks have run.
- `land` remains optional/manual; never require it as a pre-step before merge-to-main.
- CHANGELOG/README/docs coverage belongs to this merge-to-main documentation phase and the documentation expert, not to `land`.
- Final report is a two-column table plus the mandatory final verdict line.
