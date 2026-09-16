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
   If `workflow_status` shows `bdStatus=inreview`, do not stop with a normal final report before this review workflow completes. If you are not in plan mode and ownership is not stale/foreign, the interactive next action is `dispatch_reviewer(beadId=<ID>, transport=cmux, cwd=<worktree>)`. Do not report `review_bead`/`dispatch_reviewer` as unavailable based on memory, compacted context, or lack of a previous tool call: an unavailable-tool blocker requires evidence that the tool is absent from the current tool surface or that a typed call failed before review started. If review truly cannot run because tooling is unavailable or ownership is ambiguous, return an explicit Russian `BLOCKED` report with the exact evidence, blocker, and next action; `workflow_complete(state=blocked|deferred, reason=<...>)` is the only terminal local state allowed before review in that case. While a live code-reviewer pane exists, do not call `review_bead`; reuse with `followup_visible_dispatch({ beadId, role: "code-reviewer", task })`.
3. Interactive hop after supervisor complete / `inreview`: one visible code-reviewer pane, not three, not headless `review_bead`:
   ```text
   dispatch_reviewer(beadId=<ID>, transport=cmux, cwd=<workflowState.worktreePath>)
   ```
   - Return `status=spawned` is **not** DONE.
   - Layout: reviewer `new-split right` anchors the live supervisor pane (not orch) so **оркестратор** stays exclusive left and supervisor+reviewer are **side-by-side** on the right (`resolveVisibleSplitAnchor`; AGENTS.md Layout geometry).
   - Child ping uses `AGENT_NAME=code-reviewer` and the quoted `DIGEST_FILE=... bash <worktree>/.pi/orchestrator/ping.sh <taskId>` command from the task body.
   - Orchestrator delivery (exclusive; mirror dispatch-supervisor):
     A (primary): inbound `[PING]` / `[PING-ERROR]` with `taskId=` or `задача <id>` → one `complete_visible_dispatch({ taskId })`. `status=verdict` → do not call `review_bead`.
     **Autopilot runtime hop:** when `autopilotEnabled` and `plan=off`, plan-mode runtime is the **единственный consumer** of path A for reviewer ping → one complete → verdict; APPROVED + green matrix runs visible finalize close (no second `review_bead`, no «закрывай?»). NOT APPROVED → keep `inreview`, panes live, one ask. `/plan-auto` does not consume ping or auto-close.
     B (on-demand insurance, not primary): Maxim «не пинганул» / stalled without ping markers → parse latest reviewer DISPATCH spawn-ack for `taskId=` (+ optional `DIGEST_FILE=`/`RESULT_FILE=`), then exactly one `bash <worktree>/.pi/orchestrator/poll.sh <taskId>`. poll exit 0 + complete digest/result → at most one `complete_visible_dispatch`. poll exit 1 / empty → BLOCKED ask Maxim (child still working vs dead); do not probe liveness. Two hang / false-complete / insurance-poll cycles without progress → stop, ask Maxim. Forbid: background 20-min timer, `scheduler_create`, read-screen as normal path, `watchdog.sh` auto, pane dump, wait loops, re-dispatch same-turn, same-turn second complete.
   - `APPROVED` → continue acceptance/close below. `NOT APPROVED` → keep `inreview`; `complete_visible_dispatch` does not spawn a supervisor (5o03 owns supervisor-pane reuse). Do **not** call `close_visible_dispatch` on NOT APPROVED / pending-fix — keep the pane for `followup_visible_dispatch`.
   - No cmux → `BLOCKED`, not silent headless.
   - Hung/reuse of the live reviewer pane: `followup_visible_dispatch({ beadId, role: "code-reviewer", task })`.
4. Headless fallback only with **explicit** `transport=headless` or `review_bead` (not omit in interactive UI). Runtime: omit + interactive `hasUI` → cmux pane automatically; omit without UI (CI) → headless; CI must pass `transport=headless` when a dark window is required. For stacked branches, pass `endCommit=<sha>` or ensure comments contain `END_COMMIT: <sha>` so later unrelated commits are excluded:
   ```text
   review_bead(beadId=<ID>, startCommit=<sha>, endCommit=<sha>)
   # optional explicit override when needed: review_bead(beadId=<ID>, worktreePath=<task-worktree-path>)
   dispatch_reviewer(beadId=<ID>, transport=headless)
   # optional: dispatch_reviewer(beadId=<ID>, cwd=<workflowState.worktreePath>, transport=headless)
   ```
   In a main-start session, headless `review_bead` still resolves `workflowState.worktreePath`. Do not run raw mutating review/check shell commands from `main`; only read-only inspection may happen there.
5. Internal `review_bead` recovery on review-workflow runtime **hash mismatch** (not the interactive cmux hop above):
   - Guard stays fail-closed: loaded runtime sha256 must match task worktree `.pi/extensions/review-workflow/index.ts` when that file is in the scoped diff. `missing` / `not-applicable` / `matched` do **not** auto-delegate.
   - On `status===mismatch` and non-`dryRun` only, `review_bead` writes a durable `REVIEW RUNTIME DELEGATE` comment and spawns a fresh process with `cwd=<worktreePath>` and `PI_REVIEW_RUNTIME_DELEGATED=1`, forwarding `beadId` / `startCommit` / `endCommit` / `worktreePath`.
   - Preferred spawn is programmatic load of the worktree `review-workflow` module and a direct `review_bead` execute (not free-form LLM). Fallback is a fixed `pi --approve` oneshot that must call `review_bead` once and fail closed if the tool is absent.
   - Child owns the full checks → reviewer → matrix → close/`inreview` path. Parent never `bd close` on the stale path after mismatch. Parent success is only via `bd show` after a **zero** delegate exit and evidence **for this run**: matching `REVIEW RUNTIME: worktree-fresh, sha256=<worktreeSha>` with `marker.index >=` latest `REVIEW RUNTIME DELEGATE` end, plus either `closed` **or** `inreview` with a `CODE REVIEW`/`VERDICT` `NOT APPROVED` after that marker. Missing DELEGATE marker, prior-cycle marker/verdict before the latest DELEGATE, or historical NOT APPROVED alone → not success. Non-zero delegate exit → `BLOCK` (best-effort restore `inreview`); do not accept stale-comment success.
   - Child writes `REVIEW RUNTIME: worktree-fresh, sha256=<worktreeSha>` immediately after hash match and before the reviewer runs.
   - Anti-recursion: `PI_REVIEW_RUNTIME_DELEGATED=1` + mismatch → hard `BLOCK` with no second spawn. Timeout 15m applies to both programmatic (`Promise.race` + best-effort `AbortSignal`) and `pi-oneshot` (`SIGTERM`→`SIGKILL`) paths; abort kills the child process tree. Spawn failure / mid-flight crash without terminal evidence → best-effort restore `inreview` and `BLOCK`.
   - This internal recovery does **not** replace interactive cmux hop pins in step 3 (`dispatch_reviewer transport=cmux`, pane reuse, ping/complete_visible_dispatch).
6. Enforce checkpoint model: `inreview -> simplified -> reviewed -> accepted -> closed` using bd statuses plus structured comments.
7. Simplify/reuse pass:
   - record `SIMPLIFY: DONE ...`, or
   - record `SIMPLIFY: SKIPPED. docs/config only` when no code simplification is applicable.
8. Code review must check spec compliance first, then quality. Review context must include `SUPERVISOR ARTIFACT` handoff evidence when present, or explicit `ARTIFACT STATUS: N/A` when absent. Durable review comments must record artifact status as accepted / insufficient / missing / N/A. The artifact is implementation evidence only: it may be cited in an `ACCEPTANCE MATRIX` row when mapped to a criterion plus fresh verification, but it is not acceptance by itself and must not auto-advance the bead.
9. If reviewer returns `NOT APPROVED`, keep/return bead `inreview` and do not advance to `reviewed`, `accepted`, or `closed`. Visible `complete_visible_dispatch` must not spawn a supervisor after `NOT APPROVED`. Do not `close_visible_dispatch` while pending-fix reuse is needed.
10. If approved, record `CODE REVIEW: APPROVED`, run relevant acceptance checks with fresh evidence, then write an `ACCEPTANCE MATRIX:` bd comment before moving `reviewed -> accepted -> closed`. The matrix must map every `### Acceptance criteria` bullet and applicable `### Verification / acceptance checks` bullet to command/manual evidence, exit code or observed result, and `result: PASS|FAIL|NOT RUN|N/A`. `FAIL`, `NOT RUN`, `BLOCKED`, or `SCOPE GAP` stops close unless Maxim gives an explicit `HUMAN ACCEPTANCE OVERRIDE` with `approver:` and `reason:`. When session/plan evidence shows autopilot (`Approved-by: оркестратор` / `AUTOPILOT: true` / durable autopilot flag) and the matrix is fully green with `CODE REVIEW: APPROVED`, close through the standard `bd close` path **without** asking Maxim «закрывай?»; keep bead `inreview`/`in_progress` and stop the cycle on `NOT APPROVED` or any non-PASS matrix row. If the user explicitly accepts completed/inreview work with phrases such as “завершай”, “закрывай”, “принято”, “всё ок”, or “accepted”, treat that as human acceptance: record an `ACCEPTANCE MATRIX:` and override/evidence when needed, run `workflow_update(bead=<ID>, session=accepted)`, close through the standard `bd close` path, then clear/update session context to `closed`/idle. After close, `land` is not required before the next bead. Autopilot never auto-invokes `land` or `merge-to-main`.
11. For frontend Vue diffs, run the Pi Frontend Review Checklist from `beads-task-issue-tracker-vzwo` (i18n/locale sync, logging, keyboard/focus, accessible names, semantics, touch targets, contrast/state, motion, responsive/layout, regression evidence).
12. If diff touches `$t(...)` or `i18n/locales/`, verify en/ru locale key parity.
13. Close only after evidence and matrix coverage:
    ```bash
    bd comments add <ID> "ACCEPTANCE MATRIX:
    - criterion: <acceptance/verification bullet>
      evidence: <command/manual check>
      exit code: <0|n/a> / observed: <result>
      result: PASS"
    bd close <ID> --reason "Reviewed and accepted"
    ```
14. Update state after terminal close:
    ```text
    workflow_complete(state=closed, reason=<review accepted and bd closed>)
    close_visible_dispatch({ beadId: <ID> })
    ```
    After `bd close` (or terminal blocked/deferred without continuation) and no pending-fix: close **this bead's** live registry panes only (`cmux close-surface` + tombstone). NOT APPROVED / pending-fix → do not close; reuse `followup_visible_dispatch`. Never sweep foreign/historical panes.

15. STOP close (grey matrix) is **not** step 14. When CODE REVIEW is `APPROVED` but acceptance matrix is grey (`FAIL`/`NOT RUN`), bead stays non-terminal (`reviewed`) and is **not** `bd close`d. Still close this bead's live panes without waiting for terminal:
    ```text
    close_visible_dispatch({ beadId: <ID>, stopClose: true })
    ```
    - `stopClose` allowlist: `reviewed` only; `in_progress`/`inreview`/`open` → BLOCKED.
    - `pendingFix` wins (skip close). Isolation/followup files remain until later terminal close unlinks leftovers.
    - Do **not** call `followup_visible_dispatch` on grey-matrix STOP close.
    - NOT APPROVED / missing-evidence: panes stay live (no `stopClose`).
    - Autopilot hop success STOP copy: panes closed/not live; Maxim chooses (a) HUMAN ACCEPTANCE OVERRIDE → reviewed→accepted → bd close; (b) `bd update --status in_progress` + new `dispatch_supervisor`; (c) nothing, autopilot cleared.

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


## Parent epic sweep

Before closing or terminalizing a child bead, inspect `parent-child` relations. If this child is the last required child for any parent epic, record before terminalization:

```text
PARENT EPIC SWEEP
PARENT_EPIC: <EPIC_ID>
TERMINAL_CHILD: <CHILD_ID>
TARGET_TERMINAL_STATUS: <closed|blocked|deferred>
REQUIRED_CHILDREN_STATUS: <child-a=status,child-b=status>
NEXT_ACTION: finalize-epic|epic-handoff
```

and a matching parent `EPIC HANDOFF` with `REASON:`. After the child is terminal, immediately run `finalize-epic` or keep the parent handoff active with exact next action. If required children remain, write `EPIC PROGRESS` instead.

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
- Frontend/UI changes require the explicit Pi Frontend Review Checklist.
- Direct terminal status updates are invalid before accepted/reviewed-with-no-acceptance evidence; use standard `bd close` after acceptance evidence is recorded in bd comments and session context.
- A confirmed current-session bead with bd status `inreview` blocks unrelated next work; the valid next action is this review workflow. Stale/foreign session context must be reset or explicitly confirmed before any review/mutation.
- Epic completion with incomplete children is blocked by `beads-policy` for both standard close and direct `closed` status updates; close child beads first or use an explicit documented override.
- PR merged validation is required by merge/land workflows or explicit override.
- Create follow-up beads for out-of-scope findings.

## Reporting

Chat for Maxim follows `AGENTS.md`. Routine `inreview -> simplified -> reviewed -> accepted` while continuing automatically is silent. Stop for `NOT APPROVED`, failed acceptance, unavailable review tooling, ambiguous ownership, or human override: `##` + `## Дальше` with `1/2/3`.

Recoverable continue: one `Recovery:` line, then keep going.

## Final report

`##` что случилось + название задачи + (`id`). `## Проверка` — only tests/commands that actually ran (files + passed/exit). NOT APPROVED keeps `## Дальше`. Do not dump Guard/Simplify/ACCEPTANCE MATRIX rows into chat.
