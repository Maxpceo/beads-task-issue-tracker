---
name: review-bead
description: Pi-native review chain for beads in inreview. Use when supervisor finishes, bead is inreview, or user says “запусти ревью”.
---

# Review Bead

## Workflow

1. Guard:
   ```bash
   bd show <ID> --json
   ```
   Required: status `inreview`.
2. Update workflow state:
   ```text
   /workflow-update bead=<ID> state=reviewing
   ```
3. Prefer executable review workflow when available:
   ```text
   review_bead(beadId=<ID>)
   ```
4. Until `review_bead` is implemented, use typed reviewer dispatch:
   ```text
   dispatch_reviewer(beadId=<ID>)
   ```
5. Enforce checkpoint model: `inreview -> simplified -> reviewed -> accepted -> closed` using bd statuses plus structured comments.
6. If reviewer returns `NOT APPROVED`, keep/return bead `inreview` and redispatch supervisor with exact fixes; do not advance to `reviewed`, `accepted`, or `closed`.
7. If approved, record `CODE REVIEW: APPROVED`, run relevant acceptance checks with fresh evidence, then move `reviewed -> accepted -> closed`.
8. For frontend Vue diffs, run the Pi Frontend Review Checklist from `beads-task-issue-tracker-vzwo` (i18n/locale sync, logging, keyboard/focus, accessible names, semantics, touch targets, contrast/state, motion, responsive/layout, regression evidence).
9. Close only after evidence:
   ```bash
   bd close <ID> --reason "Reviewed and accepted"
   ```
10. Update state:
   ```text
   /workflow-update state=accepted
   ```

## Rules

- Never skip spec compliance.
- Evidence before claims is mandatory.
- Frontend/UI changes require the explicit Pi Frontend Review Checklist; do not require undefined RAMS/WIG.
- Direct terminal status updates are invalid before accepted/reviewed-with-no-acceptance evidence.
- Epic completion with incomplete children is tracked as follow-up `beads-task-issue-tracker-bco3` and blocks final verification until implemented.
- PR merged validation is tracked as follow-up `beads-task-issue-tracker-eote` and is required by merge/land workflows or explicit override.
- Create follow-up beads for out-of-scope findings.
