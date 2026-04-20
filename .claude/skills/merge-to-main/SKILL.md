---
name: merge-to-main
description: "Full merge cycle: feature branch → PR → update docs → merge → checkout main. Use PROACTIVELY when user says: make a PR, let's merge, merge to main, pull request, we're done with this branch, push to main, let's finish this feature, давай мержить, сделай PR, мержим в мастер, пора мержить, переходим в main, создай PR, влей в main, заканчиваем с этой веткой. НЕ путай с `land`: `land` — это commit + push в feature-ветку внутри сессии; `merge-to-main` — финальный PR → merge в main → checkout main. Не запускай `merge-to-main`, пока bead не reviewed + accepted."
---

# Merge to Master — Full PR + Docs + Merge Cycle

Automated workflow for merging a feature branch into main.

**IMPORTANT:** Before starting, ensure all beads are closed and code is pushed. If not — close beads and push first.

## Current state

!`git status --short && echo "===" && git branch --show-current && echo "===" && git log --oneline main..HEAD 2>/dev/null | head -20`

## Step 1: Pre-flight Checks

```bash
git status --short
git branch --show-current
git log --oneline main..HEAD
bd list --status=open
bd list --status=in_progress
```

Verify:
- Current branch is NOT main (if on main → STOP, tell user "Already on main")
- No uncommitted changes (if any → commit first)
- No open/in_progress beads (if any → close them first)
- All code is pushed (`git log origin/<branch>..HEAD` should be empty)

Run quality gates:
```bash
pnpm test && npx vue-tsc --noEmit
```

If tests fail → STOP, fix before merging.

## Step 2: Create Pull Request

Compose PR title and body from `git log main..HEAD`:
- Title: concise summary (< 70 chars, English)
- Body: summary + key changes list

```bash
gh pr create --base main --title "..." --body "$(cat <<'EOF'
## Summary
- bullet points

## Changes
[key changes from git log]
EOF
)"
```

Show PR URL to user.

## Step 3: Update Documentation

Dispatch the documentation-expert agent using natural language delegation:

```
Agent(
  prompt="Use the documentation-expert agent to update project documentation.

Branch being merged: <current branch name>
Commits: <output of git log main..HEAD --oneline>

Follow the instructions in .claude/agents/documentation-expert.md exactly.
After updating, commit and push."
)
```

Wait for agent to complete. Show user what was updated.

## Step 4: Wait for CI

After the docs-expert agent pushes its commit, CI runs again on the latest branch state. We must NOT merge until all checks pass — otherwise we merge broken code into main.

Capture the PR number (from Step 2 `gh pr create` output — it returns a URL ending in `/pull/<N>`), then block on GitHub Actions:

```bash
gh pr checks <PR_NUMBER> --watch --fail-fast
```

Behavior:
- `--watch` — blocks until all checks complete (can take several minutes — that's fine, just wait).
- `--fail-fast` — exits immediately with non-zero as soon as any check fails.
- Exit 0 → all required checks passed → proceed to Step 5.
- Exit non-zero → a check failed or was cancelled. **STOP.** Do NOT merge. Report to the user:
  - Which check failed (from the command output)
  - The PR URL so they can inspect logs
  - Do not retry blindly — the user must investigate and fix the failure on the branch. Typically: pull latest, reproduce the failure locally (`pnpm test` / `npx vue-tsc --noEmit` / `cargo check`), fix, commit, push, and re-run the skill from Step 4.

**Important:** If the PR has no CI configured (`gh pr checks` reports "no checks reported"), treat that as a warning and ask the user whether to proceed. Do NOT silently skip.

## Step 5: Merge PR (через merge-slot)

Захватить `bd merge-slot` ПЕРЕД `gh pr merge` — гарантирует, что merge + последующий `git pull origin main` (Step 6) атомарны относительно других параллельных сессий, которые тоже могут мёрджить свои PR. Слот удерживается ~10–30 секунд.

```bash
bd merge-slot acquire

gh pr merge <PR_NUMBER> --merge --delete-branch
```

**При любом исходе — release слота:** если `gh pr merge` упал (конфликты, permission denied, branch out-of-date, и т.д.) — ОБЯЗАТЕЛЬНО выполнить `bd merge-slot release` ДО того как репортить пользователю. Слот, который не освободили, заблокирует все остальные сессии до ручного release.

```bash
# на любой ошибке merge:
bd merge-slot release
# затем сообщить пользователю об ошибке и помочь разрешить
```

## Step 6: Switch to main + release слота

```bash
git checkout main && git pull origin main

# Освободить merge-slot — следующая параллельная сессия может мёрджить.
bd merge-slot release
```

## Step 7: Report

Show user:
- PR URL (link)
- What documentation was updated
- Confirmation: "On main branch, everything up to date"
- Reminder: "To release a version, run ./release.sh"
