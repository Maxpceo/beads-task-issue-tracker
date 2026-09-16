# Plan Mode Extension

Project-local Pi plan mode adapted for the beads workflow.

## Features

- Read-only exploration mode via `/plan` or clear natural-language activation phrases.
- **Complete-when-ready (strict only):** ready-UI opens only after explicit `plan_mode_complete({ plan })`. Clarifying turns without complete do **not** show Execute.
- Document-flow ready/question UI (no floating `overlay: true`): RU buttons Исполнить / Остаться / Уточнить / Отправить на plan-review; digits 1–9 + option preview on questionnaire.
- Ready button «Отправить на plan-review» runs the same uncapped critique path as `/plan-review` (findings via `sendMessage`), keeps plan mode ON, does **not** write `PLAN APPROVED`, does **not** increment `workflow_plan_review` cycle, then re-shows the four buttons.
- Auto-execute mode via `/plan-auto` with a required multi-agent plan-review gate before implementation (no ready-UI; pending ready cleared).
- Autopilot mode via `/plan-autopilot` (separate from `/plan-auto`): same plan-review gate, durable `Approved-by: оркестратор`, and a session `autopilot` flag that survives `plan=off` after approval (no ready-UI).
- Agent-operable `workflow_plan_review` typed tool for autonomous strict plan mode.
- Single `questionnaire` tool (example-compatible JSON schema) with project-local renderer; RPC/`!hasUI` falls back to capped `select`/`input` without hanging on `ui.custom`.
- Tool restriction to read-only tools while planning.
- Bash allowlist for read-only commands, including `git status`/`git log`/`git diff`/`git show` history inspection and pipelines where every segment is allowlisted read-only (for example `git log ... -- path | head -80`); shell control operators such as `&&`, `||`, and `;` remain blocked.
- bd-aware allowlist/blocklist:
  - allowed: `bd show`, `bd comments`, `bd list`, `bd ready`, selected read-only `bd dep`/`bd dolt` commands;
  - blocked: `bd create`, `bd update`, `bd close`, mutating comments, merge-slot acquire/release, Dolt commit/push/pull.
- Plan extraction from numbered `Plan:` / `Revised plan:` sections.
- Execution progress via `[DONE:n]` markers.
- Session persistence.

## Commands

- `/plan` — toggle strict plan mode. User approval is required before execution.
- `/plan-auto` — enter plan mode and auto-execute only after required plan-review agents run and the revised plan passes the gate. Records `Approved-by: Максим`. Does **not** close the bead by itself and does **not** set the durable autopilot flag.
- `/plan-autopilot` — same plan-review gate as `/plan-auto`, but records `Approved-by: оркестратор`, sets a durable session `autopilot` flag that survives `plan=off` after approval, and runs the **runtime hop** (exclusive consumer while `autopilot=true` and `plan=off`): inbound `[PING]`/`[PING-ERROR]` → one `complete_visible_dispatch` → `requestReviewerDispatch` after supervisor submit → green matrix close without «закрывай?». Does **not** call `land` / `merge-to-main`.
- `/plan-cancel` — cancel plan mode, clear autopilot, and restore normal tools.
- `/plan-review` — run required plan-review agents against the latest draft plan without approving or executing it.
- `/todos` — show current plan progress.
- `Ctrl+Alt+P` — toggle strict plan mode.

### Strict ready tools

- `questionnaire` — ask clarifying questions (does not mark the plan ready).
- `plan_mode_complete({ plan })` — mark the draft plan ready; whitespace-only plan errors. On the following `agent_end` in strict mode, show the four-button ready-UI. Auto/autopilot notes the call but skips ready-UI and clears pending.

### Strict complete-when-ready contract

1. Ask questions only via `questionnaire`.
2. When the draft is complete, call `plan_mode_complete({ plan })` last in the turn.
3. Human chooses: execute (durable PLAN APPROVED) / stay / refine / plan-review critique.
4. Plan-review from the button is critique, not approval and not supervisor start.

## Natural-language activation

Clear requests to enter plan mode are handled like `/plan` and activate strict plan mode without sending the phrase to the agent. Supported phrase families include:

- Russian: `перейди в режим планирования`, `введи в режим планирования`, `переведи меня в режим планирования`, `включи режим планирования`, `активируй режим планирования`, `сделай в режиме планирования`.
- English: `enter plan mode`, `switch to plan mode`, `go to plan mode`, `enable plan mode`, `activate plan mode`, `put me into plan mode`.

Combined workflow requests with an explicit bead id are parsed by intent signals rather than exact full phrases. If a message contains one bead id, a claim/start verb, and a plan intent, Pi claims the bead and then enters strict plan mode before the agent sees the prompt. Examples:

- `beads-task-issue-tracker-zzkb возьми эту задачу в работу, выполняй в режиме планирования`
- `заклейми beads-task-issue-tracker-zzkb, делай в режиме планирования`
- `claim beads-task-issue-tracker-zzkb and plan first`

Safety guards intentionally do not auto-run workflow mutations for questions, negated commands, multiple bead ids, missing bead ids, or examples inside fenced code blocks. Informational or ambiguous prompts continue as normal user input, for example: `что такое режим планирования?`, `можно ли взять beads-task-issue-tracker-zzkb в режим планирования?`, `what is plan mode?`.

### Autopilot natural-language activation

Clear requests to work autonomously activate `/plan-autopilot` (not `/plan-auto`) and are handled without sending the phrase to the agent:

- Russian: `работаю автономно`, `работать автономно`, `работай автономно`.
- English: `work autonomously`, `working autonomously`, `enable plan-autopilot`.

The same safety guards apply: questions (`можно ли работать автономно?`), negations (`не работай автономно`), and multiple bead ids do **not** auto-activate autopilot.

## Runtime hop (autopilot exclusive consumer)

While `autopilotEnabled===true` and `plan=off`, plan-mode is the **единственный consumer** of inbound visible pings for the hop:

1. Parse `[PING]` / `[PING-ERROR]` via `parseVisiblePing` (`taskId=` or `задача <id>`). Missing id → STOP ask, no complete.
2. One `complete_visible_dispatch` per ping (concurrent lock only). `incomplete`/`result-only` allows a later ping; `submitted`/`verdict` → noop on repeat.
3. Supervisor `submitted` → one `requestReviewerDispatch({ beadId, cwd: entry.worktree, transport: cmux })`; live reviewer on bead → noop.
4. Reviewer `verdict` APPROVED + green matrix → simplified → reviewed → accepted → `bd close` → workflow closed → `close_visible_dispatch` → clear autopilot. No second `review_bead`.
5. STOP ask (panes live): `[PING-ERROR]`, `BLOCKED`/`NEEDS_CONTEXT`, `NOT APPROVED`, missing bead/worktree, blocking matrix (matrix not written for show).

`/plan-auto` does **not** set durable autopilot and does **not** consume ping. `land` / `merge-to-main` never run from this hop. `poll.sh` remains Maxim path B only (not auto-timer).

### Hop UX (messages to Maxim)

Each hop return sends **exactly one** visible message (`customType` `autopilot-hop` or `autopilot-hop-stop`). No dump+human pairs.

- Body: 2–5 Russian sentences — what happened, that hop already consumed the ping (Maxim must **not** wait for another `[PING]`), named next action, Maxim action (`не требуется` / wait / choose).
- Forbidden as the main body: `complete_visible_dispatch status=`, `close_visible_dispatch status=`, raw SUPERVISOR ARTIFACT / full `finalize.text` / ACCEPTANCE MATRIX dump, orchestrator phrase `Жду [PING]`.
- Footer (optional, technical only): `Bead:` / `taskId:` lines. Registry lookup for footer is best-effort and never changes control flow; without an entry, footer may carry `taskId` only.
- Branch copy:
  - `incomplete` — ping consumed, result not ready yet, next ping from child; not a final step.
  - `result-only` — ping consumed, artifact not review-ready, reviewer not started, panes live, next ping from child after rewrite; **not** «шаг закрыт» / «работа закончена».
  - `noop` / live reviewer — short RU progress; no machine status dump.
  - `submitted` success — reviewer started; Maxim does not wait `[PING]`.
  - `NOT APPROVED` / close-blocked / `[PING-ERROR]` / BLOCKED — human STOP without matrix body.
  - APPROVED close `closed` or `noop` — one RU success (panes closed or already not live); autopilot cleared.
  - `closeVisibleDispatch` throw after bd closed — still clear autopilot + persist + status, then **one** STOP (no success trailer).

## Multi-agent auto-execute gate

`/plan-auto` and `/plan-autopilot` share the multi-agent gate. They are only for cases where the user explicitly requested automatic plan execution. They do not execute the first draft plan. Instead:

1. The main agent produces a draft plan in read-only plan mode.
2. Pi runs required project-local plan reviewers:
   - `plan-edge-reviewer`
   - `plan-consistency-reviewer`
   - `plan-dead-zone-reviewer`
3. Reviewers return structured `PLAN REVIEW: APPROVED | NEEDS_CHANGES | BLOCKED` findings.
4. The main agent must analyze findings and produce a revised plan.
5. Auto-execute starts only if the revised plan contains all required sections and `Unresolved blockers: none`.

Required revised-plan sections:

```markdown
Reviewer findings summary:
- Summary of reviewer verdicts and important findings

Accepted findings:
- Finding accepted and concrete plan change

Rejected findings:
- Finding rejected and reason, or none

Unresolved blockers: none

Revised plan:
1. First step
2. Second step

Files to change:
- path/to/file: intended change

Acceptance:
- Command/check and expected result

Risks / rollback:
- Risk and rollback strategy

AUTO_EXECUTE_ALLOWED: true
```

If any reviewer is missing, fails, returns `BLOCKED`, or reports unresolved blockers, auto-execute is blocked and the session remains in plan mode/read-only.

### `/plan-auto` vs `/plan-autopilot`

| | `/plan-auto` | `/plan-autopilot` |
|---|---|---|
| Plan-review trio gate | yes | yes |
| Durable `Approved-by` | `Максим` | `оркестратор` |
| Session flag after `plan=off` | cleared | `autopilot` remains on |
| Close bead without Maxim «закрывай?» | no | contract yes (stop on `NOT APPROVED` / matrix FAIL/NOT RUN/BLOCKED/SCOPE GAP) |
| `land` / `merge-to-main` | never | never |

Typed tool: `workflow_plan_mode(mode=autopilot)` enters the same path as `/plan-autopilot`.

Autopilot stop conditions (orchestrator must ask Maxim, not silent continue):

- plan-review `BLOCKED` / missing reviewers / missing revised sections
- no active bead or worktree scope
- supervisor `BLOCKED` / `NEEDS_CONTEXT`
- code-review `NOT APPROVED`
- `ACCEPTANCE MATRIX` row `FAIL` / `NOT RUN` / `BLOCKED` / `SCOPE GAP`

## Strict plan critique

Strict `/plan` remains manual: it never auto-executes. When the user explicitly asks to check the current plan with agents (or runs `/plan-review`), Pi runs the same required reviewers against the latest draft plan and prints findings without mutating files, bd status, workflow approval state, or leaving plan mode. The user must still approve execution explicitly.

Autonomous planning agents should use the typed `workflow_plan_review` tool instead of relying on slash/input triggers. The tool accepts the complete `draftPlan`, runs the required reviewers, and returns structured gate details plus rendered reviewer output. It does not write files, mutate bd, approve the plan, acquire/release merge-slot, change git state, or leave plan mode. If a reviewer is missing, fails, returns `BLOCKED`, or reports unresolved blockers, the tool returns `ok: false` and the agent must keep implementation blocked.

### `workflow_plan_review` cycle cap (v1)

Cap and cycle counter live **only** in the typed `workflow_plan_review` tool (`planReviewTool`). The `/plan-auto` / `/plan-autopilot` `runReviewGateForPlan` path is intentionally unchanged.

- Max **2** reviewer spawns per plan-mode session.
- Cycle count, last `stopAdvice`, and last results are persisted/restored with plan-mode state.
- Reset only when plan mode transitions off→on (new `/plan` / first enable). Repeated `workflow_plan_mode` while already enabled does **not** reset the counter.
- Empty `draftPlan` does not increment the counter.
- Slot is reserved (increment + persist) **before** `await` spawn; a failed spawn still consumes the slot. Concurrent overlap is therefore ≤2.
- Call 3+ with `cycleCount >= 2` skips spawn and returns cached findings with `STOP_SHOW_USER`.

Exclusive stop table (`planReviewStopAdvice`; risk is never an argument):

| Condition | `stopAdvice` |
|---|---|
| `!gateOk` | `HARD_BLOCK` |
| `gateOk` && no important/critical | `STOP_SHOW_USER` |
| `gateOk` && important/critical && `cycle < 2` | `CONTINUE` |
| `gateOk` && `cycle >= 2` | `STOP_SHOW_USER` |

Tool `details` always include `{ cycle, risk, stopAdvice }`. `classifyPlanReviewRisk` is telemetry only (`low` iff `FAST_PATH_RATIONALE:` and no denylisted `.pi/extensions|skills|agents|rules` / `scripts/` and not both `app/` + `src-tauri`; else `high`). Risk does not change advice and does not auto-approve.

Cycle-aware plan-mode injection is exclusive: either `MUST call workflow_plan_review` or `MUST NOT call workflow_plan_review`, never both. After `STOP_SHOW_USER` or when the cap is reached, the agent must show Maxim the plan (remaining important/critical findings stay visible) and must not start a third cycle.

## Responsibility split

This extension owns real plan-mode behavior: tool access, read-only command gates, plan extraction, and plan execution. It also emits `workflow-state:update` events so `.pi/extensions/workflow-state` keeps session fields synchronized while bd remains lifecycle authority:

- `/plan` or a supported natural-language activation phrase -> `plan=strict`, `sessionMode=planning`
- `/plan-auto` -> `plan=auto`, `sessionMode=planning`
- `/plan-autopilot` or NL «работаю/работать автономно» -> `plan=auto`, `sessionMode=planning`, plus durable plan-mode `autopilot` flag
- `/plan-cancel` -> `plan=off`, clears autopilot, and `sessionMode=idle` when the current session is still planning
- executing an approved plan -> `plan=off`, `planApproved=true`, and `sessionMode=implementing` when the current session is still planning; `/plan-autopilot` keeps the session `autopilot` flag after `plan=off`

The `workflow-state` extension stores session context such as active bead, branch, worktree, merge-slot hint, plan approval, review/acceptance session mode, landing, and idle reset. It displays live `bdStatus`, but bd remains the source of truth for bead lifecycle.
