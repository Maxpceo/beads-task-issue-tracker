---
name: dispatch-supervisor
description: Pi-native supervisor dispatch after an approved plan. Use after plan approval or when user says “запусти supervisor”, “dispatch”, “начни реализацию”.
---

# Dispatch Supervisor

This skill runs only after a bead is claimed and the plan is approved. Approved plan means approved dispatch; do not ask an extra “continue?” question unless there is a real decision point. When the durable plan comment has `Approved-by: оркестратор` / `AUTOPILOT: true`, continue the same automatic path; still stop and ask Maxim on supervisor `BLOCKED`/`NEEDS_CONTEXT`. Autopilot does not authorize `land` or `merge-to-main`.

## Workflow

1. Guard session context and bd status in the orchestrator/wrapper, not inside the child supervisor. Use `workflow_status` when available before calling `dispatch_supervisor`; child supervisors must not be asked to call `workflow_status`.
   Required: current-session active bead exists, matches `<ID>`, bd status is `in_progress`, and session context shows an approved plan (`planApproved=true` or `sessionMode=plan_approved/implementing`). If any other current-session active bead has non-terminal bd status, stop; if bd status is `inreview`, continue with `review-bead`.
2. Guard bead:
   ```bash
   bd show <ID> --json
   bd comments <ID> --json
   git branch --show-current
   git rev-parse HEAD
   ```
   Required: status `in_progress`, assignee is this session/user, no unresolved blockers, self-contained handoff sections from `AGENTS.md`, concrete acceptance/verification bullets, labels, canonical task scope (`BRANCH` is `<type>/<bead-suffix>-<domain-or-component>-<purpose>` and worktree basename exactly equals the branch suffix), and an approved plan comment for non-fast-path work.
3. Approved plan marker: use `PLAN APPROVED` with the same readiness matrix as `.pi/extensions/beads-dispatch/index.ts`:
   ```text
   PLAN APPROVED
   Approved-by: <user/orchestrator>
   Approved-at: <ISO/date>
   Start-commit: <git sha> # or START_COMMIT: <git sha>
   Files to change: <paths>
   Plan: <implementation steps> # or legacy Problem: + Approach:
   Problem: <summary>
   Approach: <summary>
   Rejected alternatives: <summary>
   Edge-case review: <edge cases>
   Worktree / cwd: <path>
   WORKTREE_LOCK: <mutation scope>
   Acceptance: <observable checks>
   Verification / acceptance checks: <commands/manual checks>
   Risks / rollback: <risks and rollback>
   AUTO_EXECUTE_ALLOWED: true
   ```
   Required readiness fields are the marker, approval metadata, start commit, files, acceptance, verification, and implementation intent (`Plan:` or `Problem:` + `Approach:`). The other listed fields are accepted context fields and should stay synchronized with `plan-bead`. Legacy comments like `PLAN (approved ...)` are not sufficient for typed dispatch.
4. Call typed tool, not raw subagent. Interactive visible path:
   ```text
   dispatch_supervisor(beadId=<ID>, transport="cmux", cwd=<workflowState.worktreePath>)
   ```
   - `cwd` must be the task worktree, never protected `main`.
   - Return `status=spawned` is **not** DONE and not `continuation completed`.
   - Live `new-split` uses explicit `--focus false` (no focus-pane workaround); spawn must not steal Maxim focus.
   - Layout anchor (`resolveVisibleSplitAnchor`): first agent splits right of orch; each next agent splits right of the oldest live agent pane so **оркестратор** stays exclusive left and agents pack **side-by-side** on the right half (no hard N=2 cap; practical ~4–6). Never re-split orch when another live agent exists. See AGENTS.md «Layout geometry».
   - After spawn, dispatch renames tabs per AGENTS.md Cmux layout: child `{role} · {bead-suffix}`, caller `оркестратор` (not the default `π - …` title).
   - Wrapper writes `DISPATCH (` on spawn. Do not re-dispatch the same live bead.
   - Child ping: the visible supervisor must only run the quoted `AGENT_NAME=<posix-quoted role> DIGEST_FILE=... bash <worktree>/.pi/orchestrator/ping.sh <taskId>` command from the task body (`KIND=error` after BLOCKED/NEEDS_CONTEXT). Child stdout / printing `Ping` in the child pane is not delivery and must not trigger complete. Do not use raw `cmux send` / `send-key enter`.
   - Orchestrator delivery (exclusive):
     A (primary): this-turn inbound `[PING]` or `[PING-ERROR]` with id from `taskId=` OR `задача <id>` → one `complete_visible_dispatch({ taskId })`. incomplete → no review-bead; later ping may complete again. result-only → no review-bead; later ping after rewrite allowed. submitted/noop → same-turn review-bead. status=verdict → стоп, не review-bead. Ping markers present but neither `taskId=` nor `задача <id>` → BLOCKED, ask for taskId; no complete, no review-bead, no read-screen. Any throw/error from complete_visible_dispatch → one BLOCKED, no retry, no read-screen.
     **Autopilot runtime hop:** when session has durable `autopilotEnabled` and `plan=off` (Approved-by: оркестратор / AUTOPILOT: true), plan-mode runtime is the **единственный consumer** of path A — it runs complete + `requestReviewerDispatch` without a second manual orch LLM call. Orch-LLM must not double-complete the same ping. `/plan-auto` does not enable this hop.
     B (on-demand insurance, not primary): Maxim «не пинганул» / stalled without those ping markers → one-shot `poll.sh` insurance hop (never auto-timer, never loop):
       1. Parse only the latest DISPATCH spawn-ack comment for `taskId=` (+ optional `DIGEST_FILE=` / `RESULT_FILE=`). Any required key missing → BLOCKED нет spawn-ack (no registry scan, no pane dump).
       2. Run exactly one: `bash <worktree>/.pi/orchestrator/poll.sh <taskId>` (pass `DIGEST_FILE`/`RESULT_FILE` env from spawn-ack when present). `poll.sh` reads digest ≤10 lines once; no loop, no bd, no `scheduler_create`, no 20-min hang timer.
       3. poll exit 0 + nonempty complete digest/result → at most one `complete_visible_dispatch({ taskId })`. submitted/noop → review-bead. result-only / incomplete artifact → BLOCKED artifact not review-ready (no review-bead). Any throw/error from complete_visible_dispatch → BLOCKED no retry, no read-screen.
       4. poll exit 1 / missing/empty files → do not complete; one BLOCKED: «нет digest/result. Если child ещё работает — записать оба nonempty файла и ping.sh; иначе действие Максима.» Do not probe liveness.
       5. Two hang / false-complete / insurance-poll cycles without progress → stop, ask Maxim (no third poll, no re-dispatch).
       Forbid: background 20-min timer, `scheduler_create`, read-screen as normal path, `watchdog.sh` auto, pane dump, send-key, wait loops, re-dispatch same-turn, same-turn second complete.
   - No cmux in interactive → BLOCKED. Not silent headless.
   - Explicit CI/dark-window path: `dispatch_supervisor(beadId=<ID>, transport="headless")`. Interactive omit (hasUI) resolves to cmux automatically — do not rely on headless-by-omit.
   PLAN APPROVED continuation passes `transport=cmux` and `cwd=worktreePath`. `dispatch_docs_agent` does not accept `transport`. Reviewer interactive omit/hasUI → cmux (same resolve as supervisor).
5. The tool fail-closes readiness, resolves structured task scope from workflow-state, routes to `workflowState.worktreePath` in main-start sessions, collects canonical task-worktree branch/start commit, selects agent, logs `DISPATCH` context, and runs the Pi agent. If an explicit `cwd` is passed, policy requires it to be inside the active task worktree. Required prompt fields include `BEAD_ID`, `EPIC_ID`, `BRANCH`, `START_COMMIT`, context summary, approved plan, execution contract, do-not-guess guidance, over-your-head guidance, and status vocabulary.

## Supervisor execution contract

Every `dispatch_supervisor` prompt must render the same section names, even for older approved plans. Compatibility defaults are explicit `N/A`, not silent omission; this does not weaken existing readiness checks for the PLAN APPROVED marker, approval metadata, start commit, files, acceptance, verification, and implementation intent.

- `Write zone`: paths from approved `Files to change:`; if unavailable, use bead `### Files`; do not infer broader zones.
- `Do not touch`: explicit plan `Do not touch:` when present, otherwise bead `### Out of scope`, otherwise `N/A`.
- `Sibling streams`: explicit plan `Sibling streams:` when present; until Parallel Decomposition Matrix fields exist, render `N/A` for older plans.
- `Stop rules`: stop with `NEEDS_CONTEXT` for unclear requirements/acceptance/dependencies/write zone/verification, `BLOCKED` for unsafe branch/worktree/start commit, unresolved dependencies, failing required checks without scoped fix, or policy/tooling blockers; stop before editing outside `Write zone`.
- `Verification`: approved `Verification / acceptance checks:` commands/manual checks, or explicit `N/A` only when the compatibility path applies.
- `SUPERVISOR ARTIFACT`: final supervisor report section with `Status`, `Files changed`, `Verification` command/exit/output excerpt or observed result, `Commit` SHA or explicit not-committed reason, `Concerns`, and `Artifact status`. This artifact is implementation evidence for review; it is not acceptance and must not imply bead closure. Review handoff records the artifact as accepted / insufficient / missing / N/A so acceptance matrix rows can cite it only when mapped to criteria and fresh verification.
6. Headless: wrapper waits for the child, then `DISPATCH RESULT` / maybe submit.
   Visible: spawn-ack skips wait. Child stdout is not the trigger. Primary delivery is ping (A); on-demand insurance is one-shot `poll.sh` (B) when Maxim says «не пинганул» / stall without ping — never a background hang timer. STOP/BLOCKED A/B do not call review-bead. Frozen A/B status=verdict → стоп, не review-bead. Step 7 — incomplete artifacts; step 8 — review-bead only after submitted/noop/inreview (headless/resume).
7. If the supervisor artifact is incomplete, missing verification/commit evidence, or reports `BLOCKED`/`NEEDS_CONTEXT`, do not submit for review; report the exact blocker and evidence.
8. Continue with `review-bead` automatically after the bead is `inreview`; do not start another bead or stop with a normal final report while this one is `inreview`. If `review_bead` or `dispatch_reviewer` appears unavailable, first require concrete evidence from the current tool surface or a failed typed call; do not infer unavailability from memory or compacted context. If review truly cannot run, return an explicit Russian `BLOCKED` report with evidence, blocker, and exact next action.
9. After terminal bead (`bd close` / blocked-deferred handoff) **and** no pending-fix reuse: orchestrator calls `close_visible_dispatch({ beadId })` to `cmux close-surface` this bead's live registry panes and tombstone them. NOT APPROVED / pending-fix → do **not** close; keep pane for `followup_visible_dispatch`. Do not sweep foreign panes. See AGENTS.md «Close supervisor pane after terminal bead».
10. STOP close (grey matrix, non-terminal): when CODE REVIEW is APPROVED but acceptance is grey (`FAIL`/`NOT RUN`) and no pending-fix is planned, call `close_visible_dispatch({ beadId, stopClose: true })` — **not** only after `bd close`. Allowlist `reviewed` only; `pendingFix` wins; isolation files retained until later terminal close. NOT APPROVED / missing-evidence keep panes. See AGENTS.md «STOP close (grey matrix, non-terminal)».

## Supervisor selection

Typed dispatch selects the default agent from labels/description/files:

- `frontend` / `ui` / Vue/component/page/composable → `vue-supervisor`;
- `backend` / `tracker` labels, or `src-tauri` / `rust` / `cargo` in title+description → `tauri-supervisor` (bare `tauri` in prose or role names like `tauri-supervisor` does not route here);
- `ci` / `dx` / tests/workflow/tooling → `test-supervisor`.

If the domain is ambiguous, ask one concrete question with 2-4 options before dispatch.

## Rules

- Do not call raw `subagent` for workflow dispatch.
- Do not dispatch terminal, dependency-blocked, unenriched, unlabeled, unplanned, or vague-acceptance beads; enrich it or ask the user with 2-4 options first.
- Dispatch is required for risky workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain frontend+backend work unless a documented Fast Path/mechanical exception is both narrow and low-risk.
- Do not ask for confirmation after an approved plan unless a real decision point appears.
- If dispatch returns `BLOCKED` or `NEEDS_CONTEXT`, diagnose the missing context before redispatch.
- Supervisor must not close beads, set orchestrator statuses, or push; `beads-policy` enforces this in subagent contexts.
- `land` is not part of supervisor dispatch. It remains an explicit save/push checkpoint requested by the user, while `merge-to-main` is an explicit session-final workflow.

## Reporting

Chat for Maxim follows `AGENTS.md`. Do not print routine guard/pass or footer-state checkpoints while continuing from dispatch to review. Stop for `BLOCKED`, `NEEDS_CONTEXT`, failed guards, or a Maxim decision: `##` + `## Дальше` with `1/2/3`.

## Final report

`## Запустил агента` + название задачи + (`id`). Name the role; add (`agent-id`) only if it differs from the role (супервизор тестов (`test-supervisor`)). No spawn-ack, pane, or `surface:` lines in chat.
