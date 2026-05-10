---
name: release
description: Pi-native release workflow. Use when user says “сделай релиз”, “пора релизить”, “release”.
---

# Release

## Workflow

1. Pre-flight:
   ```bash
   git status -sb
   git branch --show-current
   bd list --status=in_progress
   bd list --status=inreview
   ```
2. Require clean working tree and main branch unless user explicitly requests otherwise.
3. Run quality gates:
   ```bash
   pnpm test && npx vue-tsc --noEmit
   ```
4. Review `CHANGELOG.md` `[Unreleased]` and curate release highlights.
5. Do not invent versioning. Use the project release script/process:
   ```bash
   ./release.sh
   ```
6. Capture release output and artifact links.
7. Push tags/commits only through merge-slot if the script did not already handle safe push. Use an explicit session-aware holder, compute it once, reuse it for release, and do not change `BEADS_ACTOR`:
   ```bash
   root=$(git rev-parse --show-toplevel)
   branch=$(git branch --show-current)
   branch=${branch:-no-branch}
   branch_slug=$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._/-' '_')
   wt_hash=$(printf '%s' "$root" | shasum | cut -c1-8)
   bead=${PI_ACTIVE_BEAD:-${BEAD_ID:-no-bead}}
   holder="pi:${bead}:${branch_slug}:${wt_hash}"

   bd merge-slot acquire --holder "$holder"
   # After successful acquire: /workflow-update slot=held holder=<holder>
   trap 'bd merge-slot release --holder "$holder"' EXIT
   git push --follow-tags
   bd merge-slot release --holder "$holder"
   trap - EXIT
   # After successful release: /workflow-update slot=free holder=-
   ```
8. Final report includes version, commands, exit codes, commit/tag, and links.

## Rules

- Evidence before claims.
- Do not skip changelog review.
- `main` is read-only for ordinary agent edits/commits. Release-time main mutations are allowed only inside this approved release workflow, with a clean tree, quality gates, and merge-slot-protected push/tag handling.
- If release script asks for human input or fails, stop with exact output.
- If any error happens after merge-slot acquire, release with the same `$holder` before reporting. Only mark workflow state `slot=free` after release succeeds.
