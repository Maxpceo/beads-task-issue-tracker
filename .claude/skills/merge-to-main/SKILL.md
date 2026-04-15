---
name: merge-to-main
description: "Full merge cycle: feature branch → PR → update docs → merge → checkout main. Use PROACTIVELY when user says: make a PR, let's merge, merge to main, pull request, we're done with this branch, push to main, let's finish this feature, давай мержить, сделай PR, мержим в мастер, пора мержить, переходим в main, создай PR, влей в main, заканчиваем с этой веткой."
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

## Step 4: Merge PR

```bash
gh pr merge --merge --delete-branch
```

If merge fails (conflicts) → tell user and help resolve.

## Step 5: Switch to main

```bash
git checkout main && git pull origin main
```

## Step 6: Report

Show user:
- PR URL (link)
- What documentation was updated
- Confirmation: "On main branch, everything up to date"
- Reminder: "To release a version, run ./release.sh"
