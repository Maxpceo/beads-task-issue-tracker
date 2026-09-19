# Plan Mode Extension

Project-local Pi plan mode adapted for the beads workflow.

## Features

- Read-only exploration mode via `/plan` or clear natural-language activation phrases.
- **Complete-when-ready (strict only):** ready-UI opens only after explicit `plan_mode_complete({ plan })`, **not** from `agent_end`. **Execute path (TUI):** short `ctx.ui.custom(createReadyUiFactory())` **with** `{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } }` and **without** `SelectList` (live HA 2026-09-18: `SelectList.render` inside custom killed Pi / `TUI.stop()`; questionnaire-style hand-rolled 1–4 / ↑↓ / Enter lives). Widget is four action labels only — no plan text, no PgUp/PgDn pager. Clean re-show in that loop uses the same overlay. **Leftover `agent_settled`:** built-in `ctx.ui.select` (custom on settled still aborted live TUI after gauq/m6ho). RPC / missing `custom` uses `select`. If execute `custom` throws, Safe loop degrades (notify + clear pending) — **no** select fallback. Clarifying turns without complete do **not** show Execute.
- **Human transcript before widgets (f3zr / ph4p / pwx6 / yxn0):** the full plan is written into the chat immediately via `pi.appendEntry("plan-ready-document")` + `pi.registerEntryRenderer`. The live document is `ClampedMarkdown` (`Markdown` + `wrapPlanMarkdownTheme(getMarkdownTheme())`, paddingX=0, post-clamp width for m6ho) — not wrap-only source. Display-only: `ClampedMarkdown` always passes `MarkdownOptions.transform: planMarkdownTransform` so column-0 H3+ (`###` / `####` …) become `## ` before parse (stock pi-tui keeps hashes for depth ≥ 3; H1 underline and H2 stay unchanged). `wrapPlanMarkdownTheme` rewrites unordered `listBullet` to `• ` **before** the base theme and returns an empty `codeBlockBorder` when the line starts with backticks, so fences are not framed with visible backticks. Stored `plan` / appendEntry content is not mutated. Limit: a column-0 `###` **inside** a fenced code block is also rewritten; indented `###` is left as-is. `plan_mode_complete.renderCall` is a compact label and must **not** dump `args.plan`. Heading/bold/fence contrast in cmux is Maxim live HA (vitest does not assert colors). `sendMessage` is **not** the plan visibility path (Pi steers it until the tool returns). Questionnaire prompt+options still use `sendMessage({ display: true }, { triggerTurn: false })` (`plan-questionnaire`). Plan-review dirty findings also go to the transcript (`plan-review-findings`); clean gate adds a short `plan-review-clean` note. During tool execute, transcript `sendMessage` always uses `triggerTurn: false` (51l5). A throw from `appendEntry` / `sendMessage` must not block the widget.
- Ready actions: execute-path TUI uses a bottom overlay custom **without** `SelectList` (labels Исполнить / Остаться / Уточнить / Отправить на plan-review); leftover/RPC uses `ctx.ui.select` with the same labels. Questionnaire stays document-flow `ctx.ui.custom` (no floating `overlay: true`, no `SelectList`) with digits 1–9 + option preview; RPC/`!hasUI` falls back to capped `select`/`input`.
- Ready button «Отправить на plan-review» runs the same uncapped critique path as `/plan-review`: notify before spawn, keeps plan mode ON, does **not** write `PLAN APPROVED`, does **not** increment `workflow_plan_review` cycle. Dirty (important/critical or gate fail): findings go to the human transcript (`plan-review-findings`, `triggerTurn: false` during execute) **and** return in the `plan_mode_complete` tool result (adjudicate + call complete again); pending cleared; no second widget. Clean: notify + short transcript note + re-show execute-path overlay (buttons only; plan already in chat). Leftover `agent_settled` dirty path uses a single `sendMessage` with `triggerTurn: true` (no active tool result channel) and leftover select.
- Auto-execute mode via `/plan-auto` with a required multi-agent plan-review gate before implementation (no ready-UI; pending ready cleared).
- Autopilot mode via `/plan-autopilot` (separate from `/plan-auto`): same plan-review gate, durable `Approved-by: оркестратор`, and a session `autopilot` flag that survives `plan=off` after approval (no ready-UI).
- Agent-operable `workflow_plan_review` typed tool for autonomous strict plan mode.
- Single `questionnaire` tool (example-compatible JSON schema) with project-local renderer; RPC/`!hasUI` falls back to capped `select`/`input` without hanging on `ui.custom`.
- Tool restriction to read-only tools while planning.
- Bash allowlist for read-only commands, including `git status`/`git log`/`git diff`/`git show` history inspection and pipelines where every segment is allowlisted read-only (for example `git log ... -- path | head -80`); shell control operators such as `&&`, `||`, and `;` remain blocked.
- **One plan=strict recovery exception:** a single `bd worktree create <absolute-path> --branch <type>/<basename>` with a canonical task branch (`feat|fix|docs|test|ci|refactor|task|chore/...`, not `main`/`master`). Used when `workflow_plan_approved` blocks on missing/protected task scope so the agent can create the worktree and retry approve with WORKTREE+BRANCH (no second human approval, no `workflow_plan_mode off`). Still blocked: `git worktree add`, `bd worktree remove|prune`, shell composition/`$()`, and extra flags. Prefer claim → create/bind → plan mode when possible; `workflow_update` / `setup-worktree` stay outside plan-mode tools.
- bd-aware allowlist/blocklist:
  - allowed: `bd show`, `bd comments`, `bd list`, `bd ready`, selected read-only `bd dep`/`bd dolt` commands, plus the recovery `bd worktree create` shape above;
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
- `plan_mode_complete({ plan })` — mark the draft plan ready; whitespace-only plan errors. In strict+TUI, appends the full plan into the chat and opens a bottom overlay of four actions immediately in the tool execute (not `agent_end`). Auto/autopilot notes the call but skips ready-UI and clears pending. If the ready-UI loop throws, notify + clear `pendingReadyPlan` and keep plan mode ON; leftover pending re-opens **select** on the next `agent_settled` (not custom).

### Strict complete-when-ready contract

1. Ask questions only via `questionnaire`.
2. When the draft is complete, call `plan_mode_complete({ plan })` last in the turn.
3. Ready-UI from `plan_mode_complete` execute (same timing as `questionnaire`) is a short `ctx.ui.custom` **with** `overlay: true` (bottom-center, buttons only) and **without** `SelectList`. The full plan is already in the chat via `appendEntry` + `ClampedMarkdown` entry renderer (mouse wheel scrolls the transcript). Tool-call chrome stays compact (`renderCall` does not dump `plan`). Do **not** open custom ready-UI from `agent_end` / leftover `agent_settled` (gauq, m6ho killed live sessions). `agent_settled` only restores leftover pending via `select`. `sendMessage` is not proof the plan is readable while a widget is open.
4. Human chooses: execute (durable PLAN APPROVED) / stay / refine / plan-review critique.
5. Plan-review from the button is critique, not approval and not supervisor start. Dirty findings land in the human transcript **and** the `plan_mode_complete` tool result (or leftover single `sendMessage` + `triggerTurn: true` after restart); clean gate notes «чисто» in the transcript and re-shows the execute-path overlay (buttons only). Leftover residual UX stays select.
6. Ready-UI failure path: notify error, clear pending ready plan, stay in strict plan mode (do not kill the session).

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
5. APPROVED close-gap split (`finalizeVisibleReviewClose` after verdict APPROVED):
   - **missing-evidence** (no `CODE REVIEW: APPROVED` in comments yet, missing `START_COMMIT`, weak supervisor artifact): **wake orchestrator** — one `autopilot-hop-wake-orch` message with `triggerTurn: true`, reason from `finalize.text` (truncated, no matrix dump), no «Действие Максима». Panes stay **live**, `close_visible_dispatch` not called, autopilot is **not** cleared by the hop. The woken orchestrator fills the gap (START/END comments, honest ACCEPTANCE MATRIX, `inreview → simplified → reviewed → accepted → bd close` ladder), then clears autopilot itself; if the gap cannot be closed in that turn — no hop/`complete_visible_dispatch`/`dispatch_reviewer` retry, clear autopilot and one short STOP to Maxim.
   - **not-approved** (latest comment NOT APPROVED) / unknown non-blocked `!ok`: human STOP (`autopilot-hop-stop`, no wake), panes live.
   - **NOT APPROVED** by verdict text / `[PING-ERROR]` / `BLOCKED`/`NEEDS_CONTEXT` artifact: panes **live**; do not call `close_visible_dispatch`.
   - **Grey-matrix blocked** (`finalize.status==="blocked"` after APPROVED): panes **closed** via `close_visible_dispatch({ beadId, stopClose: true })`; bead stays open (not `bd close`); autopilot cleared; durable `STOP CLOSE:` comment (FAIL/NOT RUN rows only, no matrix body dump). Success ask a/b/c; close throw → separate STOP without «bead уже closed» / without a/b/c.

`/plan-auto` does **not** set durable autopilot and does **not** consume ping. `land` / `merge-to-main` never run from this hop. `poll.sh` remains Maxim path B only (not auto-timer).

### Hop UX (messages to Maxim)

Each hop return sends **exactly one** visible message (`customType` `autopilot-hop`, `autopilot-hop-stop`, or `autopilot-hop-wake-orch` for the APPROVED + missing-evidence wake-orchestrator branch, which uses `triggerTurn: true` so the orchestrator LLM gets a turn). No dump+human pairs.

- Body: 2–5 Russian sentences — what happened, that hop already consumed the ping (Maxim must **not** wait for another `[PING]`), named next action, Maxim action (`не требуется` / wait / choose).
- Forbidden as the main body: `complete_visible_dispatch status=`, `close_visible_dispatch status=`, raw SUPERVISOR ARTIFACT / full `finalize.text` / ACCEPTANCE MATRIX dump, orchestrator phrase `Жду [PING]`.
- Footer (optional, technical only): `Bead:` / `taskId:` lines. Registry lookup for footer is best-effort and never changes control flow; without an entry, footer may carry `taskId` only.
- Branch copy:
  - `incomplete` — ping consumed, result not ready yet, next ping from child; not a final step.
  - `result-only` — ping consumed, artifact not review-ready, reviewer not started, panes live, next ping from child after rewrite; **not** «шаг закрыт» / «работа закончена».
  - `noop` / live reviewer — short RU progress; no machine status dump.
  - `submitted` success — reviewer started; Maxim does not wait `[PING]`.
  - `NOT APPROVED` (verdict text), finalize `not-approved`, unknown non-blocked `!ok`, `[PING-ERROR]`, BLOCKED artifact — human STOP without matrix body; **panes live**; close not called.
  - APPROVED + finalize `missing-evidence` — `autopilot-hop-wake-orch` with `triggerTurn: true`: no «Действие Максима», reason from `finalize.text`, orchestrator closes the gap itself (matrix + ladder) or fail-stops with autopilot cleared; **panes live**.
  - Grey-matrix `finalize.status==="blocked"` — STOP close: `stopClose:true`, panes closed/not live, bead not closed, autopilot cleared, durable `STOP CLOSE:` (no `UNIQUE_MATRIX`/matrix body dump); Maxim a/b/c. Close throw on blocked → separate STOP (panes may remain; no «bead уже closed»; no a/b/c).
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

### `workflow_plan_review` cycle cap (v2)

Cap and cycle counter live **only** in the typed `workflow_plan_review` tool (`planReviewTool`). The `/plan-auto` / `/plan-autopilot` `runReviewGateForPlan` path is intentionally unchanged. Ready-UI / `/plan-review` stay uncapped and do **not** increment this counter.

Two thresholds:

- Auto max **2** reviewer spawns per plan-mode session (`MAX_PLAN_REVIEW_CYCLES`) — default against infinite nits (eb4k).
- Orchestrator extra ceiling **4** (`MAX_PLAN_REVIEW_TOTAL_SPAWNS`) — blocks agent self-loop of `extraCycle` without Maxim.

Skip / spawn matrix:

- Empty `draftPlan` → error, counter stays 0 (including with `extraCycle` / `requestedBy`).
- `skipForAuto` = auto cap reached && !`extraCycle`.
- `skipForTotal` = total cap reached && !(`extraCycle` && `requestedBy === "maxim"`).
- Otherwise spawn and increment (including cycle 5+ for Maxim).

`requestedBy` is optional enum `maxim` | `orchestrator`. Default fail-closed to `orchestrator` when omitted. `extraCycle` without label = orchestrator.

- Cycles **3–4**: `extraCycle: true`, default `requestedBy=orchestrator`, when Maxim asks **or** residual important/critical remain on a high-risk plan (not Fast Path nits). Label `3/4 (extra)` / `4/4 (extra)`.
- Cycle **5+**: only `{ draftPlan, extraCycle: true, requestedBy: "maxim" }` when Maxim explicitly asked **this turn**. Residual-OR does **not** justify cycle 5+. Label `5 (extra, maxim)` (no `/4` denominator).
- Orchestrator extra skip only when `cycleCount >= 4`; cycles 3–4 still spawn for orch extra.
- Extra path never returns `CONTINUE` (always `STOP_SHOW_USER` or `HARD_BLOCK`).
- Cycle count, last `stopAdvice`, and last results are persisted/restored with plan-mode state. `lastRequestedBy` is details-only, not a bypass.
- Reset only when plan mode transitions off→on (new `/plan` / first enable). Repeated `workflow_plan_mode` while already enabled does **not** reset the counter.
- Slot is reserved (increment + persist) **before** `await` spawn; a failed spawn (including failed maxim extra) still consumes the slot.
- Without `extraCycle`, call 3+ with `cycleCount >= 2` skips spawn and returns cached findings with `STOP_SHOW_USER`.
- After auto cap, still call `plan_mode_complete` so ready-UI button exists.

Exclusive stop table (`planReviewStopAdvice`; risk is never an argument):

| Condition | `stopAdvice` |
|---|---|
| `!gateOk` | `HARD_BLOCK` |
| `gateOk` && no important/critical | `STOP_SHOW_USER` |
| `gateOk` && important/critical && `cycle < 2` | `CONTINUE` |
| `gateOk` && `cycle >= 2` (includes extra cycles 3–4 and Maxim 5+) | `STOP_SHOW_USER` |

Tool `details` always include `{ cycle, risk, stopAdvice }` and may include `extraCycle` / `requestedBy` / `skippedSpawn`. `classifyPlanReviewRisk` is telemetry only (`low` iff `FAST_PATH_RATIONALE:` and no denylisted `.pi/extensions|skills|agents|rules` / `scripts/` and not both `app/` + `src-tauri`; else `high`). Risk does not change advice and does not auto-approve.

Cycle-aware plan-mode injection is exclusive: either `MUST call workflow_plan_review` (below auto stop) or the stop prompt (after auto cap / `STOP_SHOW_USER`), never both. After auto stop the prompt documents the `extraCycle` path — it does **not** claim a third cycle is physically impossible. After orchestrator ceiling 4 the prompt forbids orch extra and allows only `extraCycle: true, requestedBy: "maxim"` when Maxim asked this turn — it does **not** say a fifth cycle is impossible for the human.

## Responsibility split

This extension owns real plan-mode behavior: tool access, read-only command gates, plan extraction, and plan execution. It also emits `workflow-state:update` events so `.pi/extensions/workflow-state` keeps session fields synchronized while bd remains lifecycle authority:

- `/plan` or a supported natural-language activation phrase -> `plan=strict`, `sessionMode=planning`
- `/plan-auto` -> `plan=auto`, `sessionMode=planning`
- `/plan-autopilot` or NL «работаю/работать автономно» -> `plan=auto`, `sessionMode=planning`, plus durable plan-mode `autopilot` flag
- `/plan-cancel` -> `plan=off`, clears autopilot, and `sessionMode=idle` when the current session is still planning
- executing an approved plan -> `plan=off`, `planApproved=true`, and `sessionMode=implementing` when the current session is still planning; `/plan-autopilot` keeps the session `autopilot` flag after `plan=off`
- `workflow_plan_approved` preflights task worktree scope; when blocked on missing/protected main scope it returns recovery with executable `bd worktree create … --branch …` taken from plan evidence WORKTREE/BRANCH when available, then retry approve (no second human approval)
- **Fast Path skip after approve:** when approved `planEvidence` has a nonempty `FAST_PATH_RATIONALE:` field-line and session autopilot is **off**, post-approval continuation does **not** call `dispatch_supervisor` / pre-dispatch spawn. Durable `PLAN APPROVED`, plan mode off, and `sessionMode=implementing` still apply; tool details include `fastPathSkip: true`. UI Execute and `/plan-auto` set `triggerTurn: true` so the orchestrator keeps implementing in-session; in-turn `workflow_plan_approved` uses display-only skip (`triggerTurn: false`). Missing rationale, or autopilot on, keeps the normal supervisor continuation path. This does not change hop ping consume or `/plan-autopilot` close semantics.

The `workflow-state` extension stores session context such as active bead, branch, worktree, merge-slot hint, plan approval, review/acceptance session mode, landing, and idle reset. Claim/reconcile never records protected `main`/`master` cwd as task BRANCH/WORKTREE/START_COMMIT (empty until canonical bind). It displays live `bdStatus`, but bd remains the source of truth for bead lifecycle.
