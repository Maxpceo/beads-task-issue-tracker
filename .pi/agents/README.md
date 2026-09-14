# Pi Agent Parity Notes

Claude agent files are read-only references. Pi keeps an active project-local agent set in `.pi/agents/` and moves shared workflow/codebase rules into `AGENTS.md`, `.pi/rules/domain.md`, `.pi/rules/codebase.md`, and typed tools (`dispatch_supervisor`, `review_bead`, `dispatch_docs_agent`).

| Claude role | Pi replacement | Status |
|---|---|---|
| `vue-supervisor` | `.pi/agents/vue-supervisor.md` + typed `dispatch_supervisor` + path rules | Ported with shared parity contract |
| `tauri-supervisor` | `.pi/agents/tauri-supervisor.md` + typed `dispatch_supervisor` + path rules | Ported with shared parity contract |
| `test-supervisor` | `.pi/agents/test-supervisor.md` + typed `dispatch_supervisor` + path rules | Ported with shared parity contract |
| `code-reviewer` | `.pi/agents/code-reviewer.md` + `review_bead` / `dispatch_reviewer` + path rules | Ported/replaced with typed review workflow |
| `documentation-expert` | `.pi/agents/documentation-expert.md` + `dispatch_docs_agent` + path rules | Ported |
| `architect` | `.pi/agents/architect.md` | Active planning/design agent for plan review, trade-offs, task breakdowns, and architecture gaps |
| `detective` | `.pi/agents/detective.md` | Active investigation agent for root-cause analysis, dead-zone discovery, evidence gathering, and fix recommendations |
| `discovery`, `scout`, `scribe`, `merge-supervisor` | No active Pi workflow caller | Intentionally omitted until a Pi workflow invokes them |

All active Pi agents must preserve: `BEAD_ID` input when supplied, read bead first, “Do not guess”, Evidence before claims, strict `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT` status vocabulary, and concise factual completion reports. Agents treat bd status as bead lifecycle authority; Pi workflow-state/session fields are context for ownership, plan/session mode, scope, and merge-slot hints.

## Rule delivery model

- Pi source of truth for project behavior is `AGENTS.md` plus `.pi/*`.
- `.claude/*` and `PROJECT-CONTEXT.md` are reference inputs for explicit parity/migration work, not active Pi workflow rules.
- `dispatch_supervisor`, `dispatch_reviewer`, `dispatch_docs_agent`, and `review_bead` render `PATH_RULES_LOADED` from global rules and relevant path-scoped rules.
- Global path rules include:
  - `AGENTS.md`
  - `.pi/rules/domain.md`
  - `.pi/rules/codebase.md`
- Generic `subagent` calls run project agents with isolated context but do not automatically render `PATH_RULES_LOADED`. In strict plan mode, use the dedicated `plan_subagent` tool for read-only `detective`/`architect` work; it injects bead/plan context from the wrapper and forces the child tool surface to `read,grep,find,ls`. Implementation supervisors still go through typed workflow dispatch after approval.

## Reporting and model guidance

### Per-agent model + thinking routing (project-local)

Source of truth is **project** `.pi/agent-models.json` (committed). Not `~/.pi`. Agent frontmatter `model:` / `thinking:` is not the routing source of truth for child spawns.

**Primary UX:** `/agent-models` with **no args** opens an interactive menu (`ctx.ui.select` / model picker / thinking picker) when UI is available. Without UI (CI/headless host) the same empty invocation falls back to a text `show` dump — it never blocks on `select`.

**Discovery:** menu/show list agents from a filesystem scan of project `.pi/agents/*.md` (skip `README.md`), unioned with keys already in `agentClasses` / `roles`. A new `foo.md` is visible immediately as **unmapped → session inherit** with an assign action; creating the file does **not** auto-write `agentClasses`. Stale JSON keys (no matching `.md`) are shown and can be removed. Visible cmux and headless use the **same** policy per agent name.

**Model resolve** when spawning a child Pi process (`dispatch_supervisor` / `dispatch_reviewer` headless+cmux, `review_bead`, `subagent` / `plan_subagent`):

1. `roles[agent].model` — optional per-role override
2. else `classes[agentClasses[agent]]` — power class mapping
3. else **session inherit** — do not pass `--model`

**Thinking resolve** (independent of model; levels `off|minimal|low|medium|high|xhigh|max`):

1. `roles[agent].thinking` — optional per-role override
2. else `classThinking[agentClasses[agent]]` — per-class thinking
3. else **session inherit** — do **not** pass `--thinking`

Important: explicit **`off` ≠ inherit**. Inherit omits the flag (child uses session/default thinking). Explicit `off` passes `--thinking off`. Menu label «как у class/сессии» is inherit, not `off`.

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
- `SUPERVISOR ARTIFACT`: completion evidence with `Status`, `Files changed`, `Verification`, `Commit`, `Concerns`, and `Artifact status`; it supports later review/acceptance but does not itself accept or close the bead. Wrapper auto-submit requires fresh verification evidence and commit SHA evidence, not only `Status: DONE` plus `Artifact status: complete`.

## Role boundaries

- Implementation supervisors (`vue-supervisor`, `tauri-supervisor`, `test-supervisor`) implement within the dispatched bead scope and return the `SUPERVISOR ARTIFACT`; wrapper/orchestrator code owns typed workflow preflight and review-transition routing. Supervisors must not be required to call `workflow_status` or `workflow_submit_for_review` inside the child process.
- `code-reviewer` reviews completed work and does not implement fixes unless explicitly instructed.
- `documentation-expert` updates public documentation only when the docs workflow asks for it; public README/CHANGELOG/release text stays English unless the user asks otherwise.
- `architect` designs and plans; it must not edit production code.
- `detective` investigates and recommends; it must not fix production code.
