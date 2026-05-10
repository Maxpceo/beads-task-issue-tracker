# Beads Dispatch Extension

Typed Pi dispatch wrappers for the beads workflow.

## Tools

- `dispatch_supervisor` — dispatches an in-progress bead to the selected or inferred supervisor.
- `dispatch_reviewer` — dispatches an inreview bead to `code-reviewer` by default.
- `dispatch_docs_agent` — dispatches documentation review/update work to `documentation-expert` by default.

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
