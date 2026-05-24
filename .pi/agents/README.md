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
- Generic `subagent` calls run project agents with isolated context but do not automatically render `PATH_RULES_LOADED`. When using generic `subagent` for codebase-sensitive planning or investigation, the orchestrator must include relevant rule context in the task prompt or prefer a typed workflow tool when one exists.

## Reporting and model guidance

- Use the model declared in agent frontmatter when present; otherwise use the Pi/default orchestrator-selected model. Do not copy Claude Opus/Sonnet assumptions unless a Pi model alias is explicitly configured.
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
- `SUPERVISOR ARTIFACT`: completion evidence with `Status`, `Files changed`, `Verification`, `Concerns`, and `Artifact status`; it supports later review/acceptance but does not itself accept or close the bead.

## Role boundaries

- Implementation supervisors (`vue-supervisor`, `tauri-supervisor`, `test-supervisor`) may implement within the dispatched bead scope and may set `inreview` only when their prompt/workflow permits it and evidence exists.
- `code-reviewer` reviews completed work and does not implement fixes unless explicitly instructed.
- `documentation-expert` updates public documentation only when the docs workflow asks for it; public README/CHANGELOG/release text stays English unless the user asks otherwise.
- `architect` designs and plans; it must not edit production code.
- `detective` investigates and recommends; it must not fix production code.
