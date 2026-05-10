---
name: merge-to-main
description: Pi-native merge workflow. Use when user says “мержим”, “создай PR”, “merge to main”, “давай PR”.
---

# Merge to Main

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
3. Resolve feature-related open beads: close accepted/reviewed beads or ask once if they should remain open.
4. Commit dirty files with explicit paths.
5. Run quality gates:
   ```bash
   pnpm test && npx vue-tsc --noEmit
   ```
6. Push branch via merge-slot.
7. Create PR with `gh pr create`.
8. Dispatch docs agent if user-facing changes require docs:
   ```text
   dispatch_docs_agent(beadId=<ID>)
   ```
9. Merge PR, checkout main, pull.
10. Verify clean/up-to-date state.

## Rules

- Do not run `land` before this skill; merge-to-main includes commit/push.
- `main` is read-only for ordinary agent edits/commits. Any main-branch mutation in this workflow must happen only after PR merge/checkout as part of the approved merge flow; do not make ad-hoc fixes on `main`.
- Documentation can be skipped only for internal/config/test-only changes or explicit user request.
- Terminal completion of pushed feature-branch work requires merged PR/origin-main ancestry evidence; otherwise use an explicit `PR_MERGED_EXCEPTION=<reason>`, `NO_REMOTE_BRANCH_COMPLETION_REQUIRED`, or `--pr-merged-exception <reason>` only for local-only fast-path or spike work.
- Final report is a two-column table with PR URL, merge evidence, and pushed branch evidence.
