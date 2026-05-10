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
5. If reviewer returns `NOT APPROVED`, redispatch supervisor with exact fixes.
6. If approved, run relevant acceptance checks with fresh evidence.
7. Close only after evidence:
   ```bash
   bd close <ID> --reason "Reviewed and accepted"
   ```
8. Update state:
   ```text
   /workflow-update state=accepted
   ```

## Rules

- Never skip spec compliance.
- Evidence before claims is mandatory.
- Frontend/UI changes require i18n/logging/accessibility attention.
- Create follow-up beads for out-of-scope findings.
