# Beads Dispatch Extension

Typed Pi dispatch wrappers for the beads workflow.

## Tools

- `dispatch_supervisor` — dispatches an in-progress bead to the selected or inferred supervisor.
- `dispatch_reviewer` — dispatches an inreview bead to `code-reviewer` by default.
- `complete_visible_dispatch` — after visible child ping, record DISPATCH RESULT / CODE REVIEW verdict.
- `followup_visible_dispatch` — reuse a live supervisor, code-reviewer, or documentation-expert pane. `role` is required (exact registry role); omit/empty → BLOCKED even if only one pane exists. Typical hop: `followup_visible_dispatch({ beadId, role: "<agentName>", task })` (NOT APPROVED / pending-fix).
- `close_visible_dispatch` — after terminal bead + no pending-fix: `cmux close-surface` this bead's live panes and tombstone registry entries. Optional `stopClose: true` allows the same close path on **non-terminal** `status=reviewed` only (grey-matrix STOP after CODE REVIEW APPROVED); tombstones without unlinking isolation/followup (later terminal close cleans leftovers). `pendingFix: true` still skips close and wins over `stopClose`. `in_progress` / `inreview` / `open` + `stopClose` → BLOCKED. `reviewed` is **not** in `CLOSE_VISIBLE_TERMINAL_STATUSES`.
- `dispatch_docs_agent` — dispatches documentation review/update work to `documentation-expert` by default.

Visible cmux supervisor spawns use `--no-session` and therefore have no local `workflow-state` `activeBead`. The dispatch registry records live supervisor rows so `beads-policy` `fastPathDiscipline` can recognize a unique spawned supervisor child for the cwd repo root and allow threshold-exceeding commits without `PI_SKIP_POLICY` when the bead still has `PLAN APPROVED` + `DISPATCH` evidence (see `findLiveSupervisorSpawnsForWorktree` in `cmux-transport.ts`). Orchestrator/reviewer sessions with session identity stay fail-closed.

## Why typed wrappers instead of raw subagent

The generic Pi `subagent` example is copied into `.pi/extensions/subagent/` as reference material, but the workflow uses these typed wrappers as the main API. The wrappers know about:

- bead status guards;
- branch and start commit collection;
- supervisor selection from labels/description;
- canonical dispatch prompt skeleton;
- `bd comments add` DISPATCH logging;
- Pi subprocess execution with agent system prompts from `.pi/agents/*.md`.

This reduces errors compared with asking the model to manually call a generic subagent tool.

## Agent files

The wrappers expect Pi-native agents in `.pi/agents/`, for example:

- `.pi/agents/vue-supervisor.md`
- `.pi/agents/tauri-supervisor.md`
- `.pi/agents/test-supervisor.md`
- `.pi/agents/code-reviewer.md`
- `.pi/agents/documentation-expert.md`

Those are created in the next migration phase.
