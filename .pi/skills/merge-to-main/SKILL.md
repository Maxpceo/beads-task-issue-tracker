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
- Добавьте многострочный marker в comments закрытого bead. Используйте shell quoting, который создаёт реальные переводы строк; literal `\n` внутри обычной строки не является валидным marker:
  ```bash
BRANCH=$(git branch --show-current)
WORKTREE=$(pwd)
START_COMMIT=$(git rev-parse HEAD)
bd comments add <bead-id> "$(cat <<EOF
POST-CLOSE MERGE FIX
BRANCH: ${BRANCH}
WORKTREE: ${WORKTREE}
START_COMMIT: ${START_COMMIT}
FILES: .pi/extensions/beads-policy/index.ts
REASON: <кратко зачем правка нужна для merge quality gate>
EOF
)" --json
  ```
  Marker format:
  ```text
  POST-CLOSE MERGE FIX
  BRANCH: <current branch>
  WORKTREE: <current worktree>
  START_COMMIT: <git rev-parse HEAD>
  FILES: <comma-separated repo-relative files allowed for this fix>
  REASON: <кратко зачем правка нужна для merge quality gate>
  ```
- Сделайте только строго scoped фиксы на той же `BRANCH/WORKTREE` в этом `START_COMMIT` контексте и только в файлах, перечисленных в `FILES:`. Запишите отдельный `MERGE FIX`/`ACCEPTANCE` комментарий с результатом запуска `pnpm test && npx vue-tsc --noEmit` после правки.
- Без такого marker, без `FILES:`, или при изменении файлов вне `FILES:` новые risky-изменения в `.pi/extensions` / `workflow` на уже закрытом bead блокируются.

4.2. Parent epic sweep checkpoint for session beads:
- For every session bead with `parent-child` parent epic evidence, verify the parent has post-terminal `EPIC ACCEPTANCE MATRIX` or active `EPIC HANDOFF` with `REASON:` and `NEXT_ACTION:`.
- Do not declare merge/session completion while an affected parent epic is silently non-terminal after all required children are terminal.
- This is a documented workflow checkpoint; typed router/tool enforcement is out of scope for this skill.

5. Commit dirty feature-branch files with explicit paths. Commit bead metadata separately if needed.
6. Run quality gates:
   ```bash
   pnpm test && npx vue-tsc --noEmit
   ```
7. Push branch via merge-slot. Сначала один раз сохраните имя ветки, затем синхронизируйтесь с `origin/main` явно; не используйте неявный pull+rebase, потому что у новой ветки может не быть upstream:
   ```bash
   BRANCH=$(git branch --show-current)
   bd merge-slot acquire
   git fetch origin main
   git rebase origin/main
   git push -u origin "$BRANCH"
   bd merge-slot release
   ```
   Если любая команда после `bd merge-slot acquire` завершается ошибкой, сначала выполните `bd merge-slot release`, затем остановитесь с русскоязычным отчётом: какая команда упала, её exit code, что уже сделано и следующий безопасный шаг. Исключение: trivial rebase conflict можно разрешить без вопроса к Максиму по правилам ниже; push всё равно запрещён до успешного `git rebase --continue` и повторных checks.

   Trivial rebase conflicts агент разрешает сам без дополнительного вопроса, когда все условия выполняются одновременно:
   - конфликт только additive: docs/markdown/`CHANGELOG.md`, независимые adjacent list entries или непересекающиеся абзацы, где можно сохранить обе стороны без изменения смысла;
   - нет semantic code conflict, изменения API/контракта, удаления/переименования, конфликтующих правок одной строки или неочевидного порядка;
   - разрешение не теряет пользовательский текст и не выбирает одну сторону вместо другой без причины;
   - после разрешения можно показать evidence: affected files, причина classification как trivial, `git diff`, точные `git add <files>`, `git rebase --continue`, затем quality gates/checks перед push.

   Для additive `CHANGELOG.md` conflict безопасное поведение: сохранить обе независимые записи в правильной секции `[Unreleased]`/подзаголовке, не удалять чужую запись и не объединять bullets так, чтобы менялся смысл. Порядок выбирайте по существующей структуре файла; если порядок влияет на смысл или release grouping неочевиден, это уже не trivial.

   Stop criteria для non-trivial conflict: конфликт в кодовой логике, тестовых ожиданиях, конфигурации policy/CI, API/контрактах, удалении/переименовании файлов, противоречивые изменения одной строки, риск потери пользовательского текста, неочевидный порядок/группировка, или failing checks после auto-resolution без scoped local fix. В этих случаях не продолжайте rebase/push молча: release merge-slot при необходимости и остановитесь с blocker report, где указаны конфликтующие файлы, observed diff/status и варианты `git rebase --continue` после ручного решения или `git rebase --abort`.

   Финальный merge report после auto-resolution обязан включать отдельную evidence строку: файлы конфликтов, почему они classified trivial, команды `git add <files>` и `git rebase --continue`, результат checks и exit codes.
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
    gh pr merge <PR_NUMBER> --merge
    ```
    Do **not** pass `--delete-branch`. GitHub's local checkout/delete path fails under worktree-first layouts when primary already has `main` checked out; remote branch cleanup is an explicit step below.

    After every merge attempt (exit 0 **or** non-zero), inspect PR state from the feature worktree:
    ```bash
    gh pr view <PR_NUMBER> --json state,mergeCommit
    ```
    - If `state` is not `MERGED`: run `bd merge-slot release` from the feature worktree, stop with a blocker report (no remote delete, no local worktree remove). Worktree-first conflict text such as `main is already used by worktree` is non-fatal **only** when `state=MERGED`.
    - If `state` is `MERGED` (regardless of `gh pr merge` exit code): remote branch cleanup is **required** for any MERGED PR. Stay in the feature worktree. Do **not** run `git checkout main` in the feature worktree.

    Remote cleanup from the feature worktree (literal exact-shape push only; policy is fail-closed):
    ```bash
    git fetch origin main
    BRANCH=<session canonical Pi branch>
    BRANCH_OID=$(git ls-remote --heads origin "$BRANCH" | awk '{print $1}')
    ```
    - If `BRANCH_OID` is empty (remote already gone): treat as success (already-gone remote is the only “fallback”). Immediately `bd merge-slot release` from the still-existing feature worktree, then continue local cleanup in step 12.
    - If remote still present:
      ```bash
      MAIN_OID=$(git ls-remote --heads origin main | awk '{print $1}')
      # Ensure local objects exist before ancestry (policy reports fetch-first if missing; policy does not fetch).
      git cat-file -e "${BRANCH_OID}^{object}"
      git cat-file -e "${MAIN_OID}^{object}"
      git merge-base --is-ancestor "$BRANCH_OID" "$MAIN_OID"
      # Final deletion with literal observed values only; do not use $BRANCH or $BRANCH_OID in this git push.
      git push --force-with-lease=refs/heads/fix/example-branch:0123456789abcdef0123456789abcdef01234567 origin :refs/heads/fix/example-branch
      ```
      Replace `fix/example-branch` and `0123456789abcdef0123456789abcdef01234567` in the final `git push` with the exact branch name and branch OID observed above. Stop instead of deletion if any condition is false: `BRANCH` is not the active session branch, branch does not use a canonical Pi branch prefix (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, or `task`), branch is missing on `origin`, `origin/main` is missing, local objects missing (fetch-first), branch OID is not an ancestor of main OID, lease OID does not match fresh `git ls-remote` output, merge-slot evidence is not currently held/observable, more than one deletion target would be pushed, wrappers/chdir-style git/path-qualified git/extra flags would be required, or the target is protected/unsafe (`main`, `master`, or non-canonical prefix).

    **Immediately after remote delete success or already-gone empty ls-remote**, from the still-existing feature worktree:
    ```bash
    bd merge-slot release
    ```
    Local pull / worktree remove / `branch -d` failure must **not** keep the slot held — release first, then report any local cleanup blocker.

12. Local cleanup from the primary `main` worktree (no chdir-style git flags, no feature-worktree checkout of main):
    - Resolve primary via `git worktree list`: path that has branch `main` checked out and is **not** locked.
    - Primary cwd cleanup only when the session bead is terminal (`closed` / `blocked` / explicit `deferred`) **and** lock is off. Otherwise STOP before primary pull/remove.
    - Change agent cwd to the primary path (plain shell `cd` / session cwd), then:
      ```bash
      git pull origin main
      git worktree remove <feature-worktree-path>
      git branch -d <feature-branch>   # only when branch is ancestor of main; missing branch is OK
      ```
    - If pull/remove/`branch -d` fails after slot release, report a local-cleanup blocker (slot must stay free — do not re-acquire just to finish local cleanup).
    Final verdict checks run from primary.
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

Chat for Maxim follows `AGENTS.md`. `##` + что смержили + (`id` если есть). `## Проверка` — PR/CI/merge that actually ran. Decrypt task terms; do not dump the nine-column step table into chat.

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
- Final report follows `AGENTS.md` chat canon plus the mandatory final verdict line.
