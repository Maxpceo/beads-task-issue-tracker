# Pi Agent Notes

Pi keeps an active project-local agent set in `.pi/agents/` and shared workflow/codebase rules in `AGENTS.md`, `.pi/rules/domain.md`, `.pi/rules/codebase.md`, and typed tools (`dispatch_supervisor`, `review_bead`, `dispatch_docs_agent`).

| Agent role | Pi location | Status |
|---|---|---|
| `vue-supervisor` | `.pi/agents/vue-supervisor.md` + typed `dispatch_supervisor` + path rules | Active |
| `tauri-supervisor` | `.pi/agents/tauri-supervisor.md` + typed `dispatch_supervisor` + path rules | Active |
| `test-supervisor` | `.pi/agents/test-supervisor.md` + typed `dispatch_supervisor` + path rules | Active |
| `code-reviewer` | `.pi/agents/code-reviewer.md` + `review_bead` / `dispatch_reviewer` + path rules | Active with typed review workflow |
| `documentation-expert` | `.pi/agents/documentation-expert.md` + `dispatch_docs_agent` (visible cmux by default; `complete_visible_dispatch` is result-only) + path rules | Active |
| `architect` | `.pi/agents/architect.md` | Active planning/design agent for plan review, trade-offs, task breakdowns, and architecture gaps |
| `detective` | `.pi/agents/detective.md` | Active investigation agent for root-cause analysis, dead-zone discovery, evidence gathering, and fix recommendations |
| `discovery`, `scout`, `scribe`, `merge-supervisor` | No active Pi workflow caller | Intentionally omitted until a Pi workflow invokes them |

All active Pi agents must preserve: `BEAD_ID` input when supplied, read bead first, “Do not guess”, Evidence before claims, and strict `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT` status vocabulary for orchestrator/child handoff. Chat with Maxim follows `AGENTS.md` (markdown `##`, decrypt task terms, no plaintext Кратко dump). Agents treat bd status as bead lifecycle authority; Pi workflow-state/session fields are context for ownership, plan/session mode, scope, and merge-slot hints.

## Rule delivery model

- Pi source of truth for project behavior is `AGENTS.md` plus `.pi/*`.
- `dispatch_supervisor`, `dispatch_reviewer`, `dispatch_docs_agent`, and `review_bead` render `PATH_RULES_LOADED` from global rules and relevant path-scoped rules.
- Global path rules include:
  - `AGENTS.md`
  - `.pi/rules/domain.md`
  - `.pi/rules/codebase.md`
- Generic `subagent` calls run project agents with isolated context but do not automatically render `PATH_RULES_LOADED`. Interactive `hasUI` opens visible cmux panes (sync wait, then close); CI/headless stays process+dashboard. In strict plan mode, use the dedicated `plan_subagent` tool for read-only `detective`/`architect` work; it injects bead/plan context from the wrapper and forces the child tool surface to `read,grep,find,ls`. Implementation supervisors still go through typed workflow dispatch after approval.
- Visible layout is 2 columns on the right half, then `new-split down` (`resolveVisibleSplitPlacement`; AGENTS.md Layout geometry).
- Typed `workflow_plan_review` is a blocking gate, not a ping-flow: Using Tools holds until all three visible reviewers finish (`spawnSyncVisibleAgents`, ~10 min cap). There is no `ping.sh` for the trio. On `hasUI` spawn Maxim sees one caption that оценка начнётся только когда закончат всех троих: после одного или двух ничего не произойдёт (`appendEntry` + `notify`, no `triggerTurn`). Headless/CI has no caption. Skip spawn (auto-cap / cached STOP) does not repeat it. Supervisor/code-reviewer/docs stay async ping.

## Reporting and model guidance

### Per-agent model + thinking routing (project-local)

Source of truth is **project** `.pi/agent-models.json` (committed). Not `~/.pi`. Agent frontmatter `model:` / `thinking:` is not the routing source of truth for child spawns.

**Primary UX:** `/agent-models` with **no args** opens an interactive menu (`ctx.ui.select` / model picker / thinking picker) when UI is available. Without UI (CI/headless host) the same empty invocation falls back to a text `show` dump — it never blocks on `select`.

**Searchable compact picker:** when `ctx.mode === "tui"` and `ctx.ui.custom` exists, the model step is a near-fullscreen searchable overlay (`custom(factory, MODEL_PICKER_OVERLAY_OPTIONS)` — 90% width / 85% maxHeight, center; render pad to ~100 lines) with search `Input` + `SelectList` viewport 12 and sibling `Text` «Фильтр моделей: ». Filter is case-insensitive substring on `id` / `provider` / `modelId` / `name` — **not** `SelectList.setFilter`. Selection uses `SelectList` instance `onSelect`/`onCancel` + `list.handleInput` (not hand-rolled up/down as primary). Always keep **Другая…** and **← Назад**. Cancel/Esc does not write JSON. Setup/throw until first return (path a) → `ui.notify` with real `error.message`, then fallback `select`; runtime faults inside returned `handleInput` (path b) cancel quietly without notify. RPC/json/print and missing `custom` use fallback: optional `ui.input("Фильтр моделей")`, then `select`; catalogs ≥ 40 models are capped at 30 + notify «Уточните фильтр». Handler forwards `ctx.mode` and `ctx.ui.custom` (must not strip them).

**Menu IA (Russian-first root):**

1. **Обзор** — compact human summary or raw dump («подробнее»)
2. **Настроить мощность (class)** — class wizard: pick class → live model → filtered thinking (per-step save on confirm)
3. **Состав class** — class-centric membership: pick class → notify roster (members of this class only, including stale keys) → Добавить / Убрать (inherit) / Перекинуть; bulk Add stays in the membership loop; writes only `agentClasses` on confirmed leaf; unset does not delete role model override
4. **Настроить агента** — agent wizard with badges: class / model / thinking / clear actions
5. **Уборка** — stale JSON keys (bulk delete requires confirm) and class-thinking reset
6. **← Выход**

**Back-nav:** every nested `select` includes **← Назад**. Nested Esc/null/`← Назад` returns to the previous screen. Root Esc/`← Выход` leaves the menu. Unconfirmed mid-step choices do **not** write JSON; a confirmed leaf step saves immediately.

**Live model catalog:** the model picker prefers non-empty `ctx.scopedModels`, else the project registry path: best-effort `await modelRegistry.refresh()` (Pi availability snapshot is empty until refresh), then `getAvailable()`, then if still empty `getAll()` filtered by `hasConfiguredAuth` when present (via injectable `listAvailableModels`, with timeout/catch). Ids are `provider/id`. Only when the registry is missing, still empty after refresh/getAll, throws, or times out does the menu fall back to models already present in `.pi/agent-models.json` plus **Другая…** free-text. Handler **forwards** `modelRegistry` / `scopedModels` and must not strip them.

**Thinking filter (Pi-canon `thinkingLevelMap`, mirror of `getSupportedThinkingLevels`):**

- `reasoning === false` → only `off`
- no map → `off..high` (`xhigh`/`max` hidden)
- map value `null` → hide level; string → show; omitted standard levels still show; omitted `xhigh`/`max` stay hidden
- free-text / unknown model → default `off..high`
- menu **blocks** unsupported levels; after a model change, if stored thinking is unsupported the menu **warns** and offers reset/repick
- CLI still accepts the full Pi enum only (no registry filter on CLI path)

**Discovery:** menu/show list agents from a filesystem scan of project `.pi/agents/*.md` (skip `README.md`), unioned with keys already in `agentClasses` / `roles`. A new `foo.md` is visible immediately as **unmapped → session inherit** with an assign action; creating the file does **not** auto-write `agentClasses`. Stale JSON keys (no matching `.md`) are shown and can be removed. Visible cmux and headless use the **same** policy per agent name.

**Model resolve** when spawning a child Pi process (`dispatch_supervisor` / `dispatch_reviewer` headless+cmux, `review_bead`, `subagent` / `plan_subagent`):

1. `roles[agent].model` — optional per-role override
2. else `classes[agentClasses[agent]]` — power class mapping
3. else **session inherit** — do not pass `--model`

**Thinking resolve** (independent of model; levels `off|minimal|low|medium|high|xhigh|max`):

1. `roles[agent].thinking` — optional per-role override
2. else `classThinking[agentClasses[agent]]` — per-class thinking
3. else **session inherit** — do **not** pass `--thinking`

Important: explicit **`off` ≠ inherit**. Inherit omits the flag (child uses session/default thinking). Explicit `off` passes `--thinking off`. Menu label «как у class/сессии» is inherit, not `off`. Spawn remains pass-through for stored levels (menu-time validation preferred over spawn clamp).

Empty string model ids and missing/invalid JSON are treated as inherit for spawn (spawn does not fail solely because the file is absent). Mutating commands require a valid project `.pi/` and reject unknown class names on `set agent-class` / `set class-thinking`. Role `set`/`unset` **merge** fields: setting model preserves thinking and vice versa; unsetting one field keeps the other; empty role entry is deleted.

Default power classes (all start as `xai/grok-4.5`; change via menu/CLI, not by editing agent.md). Russian menu labels: Сильная / Обычная / Дешёвая.

| Class | Label | Default model | Default agents |
|---|---|---|---|
| `strong` | Сильная | `xai/grok-4.5` | `code-reviewer`, `architect` |
| `standard` | Обычная | `xai/grok-4.5` | `vue-supervisor`, `tauri-supervisor`, `test-supervisor`, `detective` |
| `cheap` | Дешёвая | `xai/grok-4.5` | `documentation-expert`, `plan-edge-reviewer`, `plan-consistency-reviewer`, `plan-dead-zone-reviewer` |

CLI is **secondary** (project cwd/worktree only; writes only `проект/.pi/agent-models.json`). Primary forms only:

```text
/agent-models                 # menu when hasUI; else show
/agent-models show
/agent-models set class <name> <modelId>
/agent-models set class-thinking <name> <level>
/agent-models unset class-thinking <name>
/agent-models set role <agent> <modelId>
/agent-models unset role <agent>
/agent-models set role-thinking <agent> <level>
/agent-models unset role-thinking <agent>
/agent-models set agent-class <agent> <class>
/agent-models unset agent-class <agent>
```

`followup_visible_dispatch` does not restart a live pane with a new model/thinking mid-session; a changed mapping applies on the next spawn. Dry-run dispatch includes resolved `model=` and `thinking=` fields (or session inherit).

Out of scope here: dynamic auto-pick by task complexity, provider failover, mid-flight pane retune, auto-register into `chooseSupervisor`, global `~/.pi` mapping.

- Completion reports must be evidence-backed: cite commands/manual checks, exit codes, and relevant output excerpts for every claim that work is done, tests pass, docs changed, review is approved, a plan covers a rule, or an investigation found a root cause.
- Use `DONE` only when assigned scope is complete and verified; use `DONE_WITH_CONCERNS` when complete but there are non-blocking risks or skipped checks with reasons; use `BLOCKED` for missing context, unsafe branch/policy state, failing required checks, or unresolved decisions; use `NEEDS_CONTEXT` when required inputs such as `BEAD_ID`, `BRANCH`, `START_COMMIT`, symptoms, or acceptance criteria are missing.
- Keep reports concise and factual. For final user-visible task/workflow reports, include a short `Кратко` summary (`Проблема`, `Что сделал`, `Результат`) before evidence tables so Maxim sees the human context as well as proof.
- Do not include celebratory wording before evidence.
- Non-orchestrator agents must not close beads, push, acquire/release merge-slot, or set orchestrator-only bd statuses (`simplified`, `reviewed`, `accepted`, `closed`) unless the dispatch prompt explicitly grants that authority.

## Supervisor execution contract

Typed `dispatch_supervisor` prompts define a structured implementation contract for all implementation supervisors. The section names are stable and must appear even when older approved plans do not yet provide stream-specific fields; compatibility uses explicit `N/A` defaults rather than silent omission.

- `Write zone`: approved paths to edit, derived from `Files to change:` or bead `### Files`; supervisors must not broaden it without approval.
- `Do not touch`: explicit protected paths/scope, or `### Out of scope`, or `N/A`.
- `Sibling streams`: parallel stream context when available; `N/A` until matrix fields are defined.
- `Stop rules`: stop with `NEEDS_CONTEXT` for unclear requirements/acceptance/dependencies/write zone/verification, and `BLOCKED` for unsafe branch/worktree/start commit, unresolved dependencies, failing required checks without scoped fix, or policy/tooling blockers.
- `Verification`: required commands/manual checks with exit codes or observed results.
- `SUPERVISOR ARTIFACT`: completion evidence with `Status`, `Files changed`, `Verification`, `Commit`, `Concerns`, and `Artifact status`; it supports later review/acceptance but does not itself accept or close the bead. Prefer a markdown `| Item | Evidence | Result |` table so `buildAcceptanceMatrix` can map unique `PASS`/`N/A` rows with nonempty evidence onto Verification bullets (after allowlist, before suite fallback). Wrapper auto-submit requires fresh verification evidence and commit SHA evidence, not only `Status: DONE` plus `Artifact status: complete`.

## Role boundaries

- Implementation supervisors (`vue-supervisor`, `tauri-supervisor`, `test-supervisor`) implement within the dispatched bead scope and return the `SUPERVISOR ARTIFACT`; wrapper/orchestrator code owns typed workflow preflight and review-transition routing. Supervisors must not be required to call `workflow_status` or `workflow_submit_for_review` inside the child process.
- `code-reviewer` reviews completed work and does not implement fixes unless explicitly instructed.
- `documentation-expert` updates public documentation only when the docs workflow asks for it; public README/CHANGELOG/release text stays English unless the user asks otherwise.
- `architect` designs and plans; it must not edit production code.
- `detective` investigates and recommends; it must not fix production code.
