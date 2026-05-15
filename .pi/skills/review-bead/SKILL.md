---
name: review-bead
description: Pi-native review chain for beads in inreview. Use when supervisor finishes, bead is inreview, or user says “запусти ревью”.
---

# Review Bead

Run this when a supervisor returns or a bead is already `inreview`. Do not skip spec compliance. Evidence before claims is mandatory.

## Workflow

1. Guard:
   ```bash
   bd show <ID> --json
   bd comments <ID> --json
   workflow_status
   ```
   Required: status `inreview` and explicit ownership evidence. Prefer current-session ownership (matching branch/worktree/start), but after typed supervisor dispatch a durable `DISPATCH RESULT` comment with matching branch/worktree/start/end may establish the task worktree review scope. If ownership is stale, foreign, or ambiguous, do not launch `review_bead` or `dispatch_reviewer`; agents can call `workflow_reset` for stale local state, or after explicit takeover/verified dispatch evidence call `workflow_update(bead=<ID>, session=reviewing, branch=<branch>, worktree=<path>, start=<sha>, end=<sha>)`.
2. Update session context:
   ```text
   workflow_update(bead=<ID>, session=reviewing)
   ```
3. Prefer executable review workflow when available. For stacked branches, pass `endCommit=<sha>` or ensure comments contain `END_COMMIT: <sha>` so later unrelated commits are excluded:
   ```text
   review_bead(beadId=<ID>, startCommit=<sha>, endCommit=<sha>, worktreePath=<task-worktree-path>)
   ```
4. If orchestrating from a main/session checkout while implementation is in a task worktree, pass `worktreePath=<task-worktree-path>` so `review_bead` runs git diff/checks/reviewer from that worktree and validates it against durable dispatch evidence. Until `review_bead` covers another needed scenario, use typed reviewer dispatch:
   ```text
   dispatch_reviewer(beadId=<ID>)
   ```
5. Enforce checkpoint model: `inreview -> simplified -> reviewed -> accepted -> closed` using bd statuses plus structured comments.
6. Simplify/reuse pass:
   - record `SIMPLIFY: DONE ...`, or
   - record `SIMPLIFY: SKIPPED. docs/config only` when no code simplification is applicable.
7. Code review must check spec compliance first, then quality. If reviewer returns `NOT APPROVED`, keep/return bead `inreview` and redispatch supervisor with exact fixes; do not advance to `reviewed`, `accepted`, or `closed`.
8. If approved, record `CODE REVIEW: APPROVED`, run relevant acceptance checks with fresh evidence, then move `reviewed -> accepted -> closed`. If the user explicitly accepts completed/inreview work with phrases such as “завершай”, “закрывай”, “принято”, “всё ок”, or “accepted”, treat that as human acceptance: record an `ACCEPTANCE:` comment/evidence when needed, run `workflow_update(bead=<ID>, session=accepted)`, close through the standard `bd close` path, then clear/update session context to `closed`/idle. After close, `land` is not required before the next bead.
9. For frontend Vue diffs, run the Pi Frontend Review Checklist from `beads-task-issue-tracker-vzwo` (i18n/locale sync, logging, keyboard/focus, accessible names, semantics, touch targets, contrast/state, motion, responsive/layout, regression evidence). This intentionally replaces undefined Claude RAMS/WIG requirements in Pi.
10. If diff touches `$t(...)` or `i18n/locales/`, verify en/ru locale key parity.
11. Close only after evidence:
    ```bash
    bd close <ID> --reason "Reviewed and accepted"
    ```
12. Update state after terminal close:
    ```text
    workflow_complete(state=closed, reason=<review accepted and bd closed>)
    ```

## Follow-up sweep

After simplify, code review, frontend checklist, and acceptance, scan returned summaries for out-of-scope findings:

- `follow-up bead`, `отдельным bead`, `scope-cut`, `outside scope`, `pre-existing`, `not introduced by this change`, `non-critical follow-up`, `можно отложить`.

For each certain finding, create a self-contained follow-up bead with labels and `discovered-from:<ID>`. If confidence is uncertain, list it in the final report and ask one concrete question with 2-4 options.

## Knowledge capture

Record durable learnings when the review finds a reusable gotcha, decision, or pattern:

```bash
bd comments add <ID> "LEARNED: <insight>"
bd comments add <ID> "DECISION: <decision>"
bd comments add <ID> "PATTERN: <pattern>"
```

`.pi/extensions/memory-capture` captures these markers into `.beads/memory/knowledge.jsonl`. Do not capture routine facts.

## Rules

- Never skip spec compliance.
- Frontend/UI changes require the explicit Pi Frontend Review Checklist; do not require undefined RAMS/WIG.
- Direct terminal status updates are invalid before accepted/reviewed-with-no-acceptance evidence; use standard `bd close` after acceptance evidence is recorded in bd comments and session context.
- A confirmed current-session bead with bd status `inreview` blocks unrelated next work; the valid next action is this review workflow. Stale/foreign session context must be reset or explicitly confirmed before any review/mutation.
- Epic completion with incomplete children is blocked by `beads-policy` for both standard close and direct `closed` status updates; close child beads first or use an explicit documented override.
- PR merged validation is required by merge/land workflows or explicit override.
- Create follow-up beads for out-of-scope findings.

## Final report

| Шаг | Результат |
|---|---|
| Guard | status evidence |
| Simplify | done/skipped |
| Code review | APPROVED / NOT APPROVED |
| Frontend checklist | pass/not applicable/issues |
| Acceptance | command/manual evidence |
| Knowledge | captured key / — |
| Follow-up beads | IDs / — |
| Close | closed / left open with reason |
