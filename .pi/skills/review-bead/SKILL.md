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
   Required: status `inreview` and explicit ownership evidence. Prefer current-session ownership (matching branch/worktree/start), but after typed supervisor dispatch/submit a durable `DISPATCH RESULT` or `WORKFLOW SUBMIT FOR REVIEW` comment with matching branch/worktree/start/end may establish the task worktree review scope. If ownership is stale, foreign, or ambiguous, do not launch `review_bead` or `dispatch_reviewer`; agents can call `workflow_reset` for stale local state, or after explicit takeover/verified dispatch evidence call `workflow_update(bead=<ID>, session=reviewing, branch=<branch>, worktree=<path>, start=<sha>, end=<sha>)`.
2. Update session context:
   ```text
   workflow_update(bead=<ID>, state=reviewing, session=reviewing)
   ```
   If `workflow_status` shows `bdStatus=inreview`, do not stop with a normal final report before this review workflow completes. If `review_bead`/`dispatch_reviewer` is unavailable or ownership is ambiguous, return an explicit `BLOCKED` report with the exact blocker and next action; `workflow_complete(state=blocked|deferred, reason=<...>)` is the only terminal local state allowed before review in that case.
3. Prefer executable review workflow when available. For stacked branches, pass `endCommit=<sha>` or ensure comments contain `END_COMMIT: <sha>` so later unrelated commits are excluded:
   ```text
   review_bead(beadId=<ID>, startCommit=<sha>, endCommit=<sha>)
   # optional explicit override when needed: review_bead(beadId=<ID>, worktreePath=<task-worktree-path>)
   ```
4. Run review through typed task-worktree routing. In a main-start session, `review_bead` resolves `workflowState.worktreePath`, runs git diff/checks/reviewer from that worktree, and validates it against current-session or durable dispatch/submit evidence; no manual shell cwd override is required for this typed path. Do not run raw mutating review/check shell commands from `main`; only read-only inspection may happen there. Until `review_bead` covers another needed scenario, use typed reviewer dispatch:
   ```text
   dispatch_reviewer(beadId=<ID>)
   # optional explicit override when needed: dispatch_reviewer(beadId=<ID>, cwd=<workflowState.worktreePath>)
   ```
5. Enforce checkpoint model: `inreview -> simplified -> reviewed -> accepted -> closed` using bd statuses plus structured comments.
6. Simplify/reuse pass:
   - record `SIMPLIFY: DONE ...`, or
   - record `SIMPLIFY: SKIPPED. docs/config only` when no code simplification is applicable.
7. Code review must check spec compliance first, then quality. Review context must include `SUPERVISOR ARTIFACT` handoff evidence when present, or explicit `ARTIFACT STATUS: N/A` when absent. Durable review comments must record artifact status as accepted / insufficient / missing / N/A. The artifact is implementation evidence only: it may be cited in an `ACCEPTANCE MATRIX` row when mapped to a criterion plus fresh verification, but it is not acceptance by itself and must not auto-advance the bead.
8. If reviewer returns `NOT APPROVED`, keep/return bead `inreview` and redispatch supervisor with exact fixes; do not advance to `reviewed`, `accepted`, or `closed`.
9. If approved, record `CODE REVIEW: APPROVED`, run relevant acceptance checks with fresh evidence, then write an `ACCEPTANCE MATRIX:` bd comment before moving `reviewed -> accepted -> closed`. The matrix must map every `### Acceptance criteria` bullet and applicable `### Verification / acceptance checks` bullet to command/manual evidence, exit code or observed result, and `result: PASS|FAIL|NOT RUN|N/A`. `FAIL`, `NOT RUN`, `BLOCKED`, or `SCOPE GAP` stops close unless Maxim gives an explicit `HUMAN ACCEPTANCE OVERRIDE` with `approver:` and `reason:`. If the user explicitly accepts completed/inreview work with phrases such as “завершай”, “закрывай”, “принято”, “всё ок”, or “accepted”, treat that as human acceptance: record an `ACCEPTANCE MATRIX:` and override/evidence when needed, run `workflow_update(bead=<ID>, session=accepted)`, close through the standard `bd close` path, then clear/update session context to `closed`/idle. After close, `land` is not required before the next bead.
10. For frontend Vue diffs, run the Pi Frontend Review Checklist from `beads-task-issue-tracker-vzwo` (i18n/locale sync, logging, keyboard/focus, accessible names, semantics, touch targets, contrast/state, motion, responsive/layout, regression evidence). This intentionally replaces undefined Claude RAMS/WIG requirements in Pi.
11. If diff touches `$t(...)` or `i18n/locales/`, verify en/ru locale key parity.
12. Close only after evidence and matrix coverage:
    ```bash
    bd comments add <ID> "ACCEPTANCE MATRIX:
    - criterion: <acceptance/verification bullet>
      evidence: <command/manual check>
      exit code: <0|n/a> / observed: <result>
      result: PASS"
    bd close <ID> --reason "Reviewed and accepted"
    ```
13. Update state after terminal close:
    ```text
    workflow_complete(state=closed, reason=<review accepted and bd closed>)
    ```

## Acceptance failure loop breaker

Use durable attempt markers to prevent silent retry loops and token waste:

```text
ACCEPTANCE ATTEMPT: <N>
criterion: <failed criterion>
evidence: <command/manual check>
result: FAIL | NOT RUN | BLOCKED | SCOPE GAP
next action: fix | ask Maxim | follow-up | override request
```

- One automatic fix/redispatch is allowed only when the failure is concrete, in scope, and likely fixable.
- Stop and ask Maxim after the same criterion fails twice, after two acceptance-fix cycles total, or when the result is `NOT RUN`, `BLOCKED`, or `SCOPE GAP` and cannot be resolved by one local command.
- The stop report must be a delta report: failed criterion, last one/two attempts, why automatic retry stopped, and 2-4 concrete options. Do not re-summarize the whole bead.
- Do not launch another supervisor/reviewer silently after the loop breaker triggers. Valid options are an approved expanded plan, a follow-up/scope cut, marking the bead blocked/deferred, or a human override with approver and reason.

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

## Reporting

Use a full `Где мы в workflow` block for `NOT APPROVED`, failed acceptance, unavailable review tooling, ambiguous ownership, human acceptance/override requests, and final review reports. Routine `inreview -> simplified -> reviewed -> accepted` progress while continuing automatically should be silent or summarized only in the final evidence table.

For recoverable errors where review can continue safely, prefer a short note:

```text
Recovery: acceptance command failed because dependencies were missing; `pnpm install --frozen-lockfile` restored the environment, continuing checks.
```

## Final report

| Шаг | Результат |
|---|---|
| Guard | status evidence |
| Simplify | done/skipped |
| Code review | APPROVED / NOT APPROVED |
| Frontend checklist | pass/not applicable/issues |
| Acceptance | acceptance coverage table with criterion, evidence, exit code/observed result, PASS/FAIL/NOT RUN/N/A |
| Knowledge | captured key / — |
| Follow-up beads | IDs / — |
| Close | closed / left open with reason |
