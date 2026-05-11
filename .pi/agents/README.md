# Pi Agent Parity Notes

Claude agent files are read-only references. Do not modify `.claude/*` for Pi workflow changes. Pi project agents live in `.pi/agents/*.md` and use Pi-compatible frontmatter/tool names for the subagent extension.

Shared workflow rules live in `AGENTS.md`, `.pi/rules/domain.md`, `.pi/skills/*`, typed tools (`dispatch_supervisor`, `review_bead`, `dispatch_docs_agent`), and `.pi/plans/pi-native-workflow-migration.md`.

| Claude role | Pi replacement | Status |
|---|---|---|
| `architect` | `.pi/agents/architect.md` | Ported for system design/planning; no implementation authority |
| `code-reviewer` | `.pi/agents/code-reviewer.md` + `review_bead` | Ported/replaced with typed review workflow |
| `code-simplifier` plugin | `.pi/agents/code-simplifier.md` + `review_bead` simplify phase | Ported from standalone Claude plugin; runs before code review for applicable code diffs |
| `detective` | `.pi/agents/detective.md` | Ported for bug investigation/root-cause analysis; no fix authority |
| `discovery` | No Pi replacement | Intentionally omitted by request |
| `documentation-expert` | `.pi/agents/documentation-expert.md` + `dispatch_docs_agent` | Ported |
| `merge-supervisor` | `.pi/agents/merge-supervisor.md` | Ported for conflict resolution when orchestrator explicitly dispatches it |
| `scout` | `.pi/agents/scout.md` | Ported for exploration/file discovery; no implementation authority |
| `scribe` | `.pi/agents/scribe.md` | Ported as lightweight docs writer; distinct from `documentation-expert`, which owns broader documentation review/workflows |
| `tauri-supervisor` | `.pi/agents/tauri-supervisor.md` + domain rules | Ported with shared parity contract |
| `test-supervisor` | `.pi/agents/test-supervisor.md` + domain rules | Ported with shared parity contract |
| `vue-supervisor` | `.pi/agents/vue-supervisor.md` + domain rules | Ported with shared parity contract |

All active Pi agents must preserve: `BEAD_ID` input when provided, read bead context first, “Do not guess”, evidence before claims, concise factual completion reports, and strict status vocabulary where the source role defines it (`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, `NEEDS_CONTEXT`). Non-review/non-orchestrator agents must not close beads, push, or set orchestrator-only statuses unless the dispatch prompt explicitly authorizes it.
