# Pi Agent Parity Notes

Claude agent files are read-only references. Pi keeps a smaller active agent set and moves shared workflow rules into `AGENTS.md`, `.pi/rules/domain.md`, and typed tools (`dispatch_supervisor`, `review_bead`, `dispatch_docs_agent`).

| Claude role | Pi replacement | Status |
|---|---|---|
| `vue-supervisor` | `.pi/agents/vue-supervisor.md` + domain rules | Ported with shared parity contract |
| `tauri-supervisor` | `.pi/agents/tauri-supervisor.md` + domain rules | Ported with shared parity contract |
| `test-supervisor` | `.pi/agents/test-supervisor.md` + domain rules | Ported with shared parity contract |
| `code-reviewer` | `.pi/agents/code-reviewer.md` + `review_bead` | Ported/replaced with typed review workflow |
| `documentation-expert` | `.pi/agents/documentation-expert.md` + `dispatch_docs_agent` | Ported |
| `architect` | No active Pi agent yet | Intentionally documented gap: `managing-epics` says the orchestrator drafts design docs in plan mode unless a Pi architect/design-doc agent is added later |
| `discovery`, `scout`, `scribe`, `merge-supervisor` | No active Pi workflow caller | Intentionally omitted until a Pi workflow invokes them |

All active Pi agents must preserve: `BEAD_ID` input, read bead first, “Do not guess”, Evidence before claims, strict `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT` status vocabulary, and concise factual completion reports.
