# Adaptation Report — beads-task-issue-tracker-6fyz

Sources were copied at maximum fidelity, then adapted only for Pi execution compatibility and workflow safety. `.claude/*` files were not modified.

## Mechanical changes applied to all project-agent ports

| Source line/section | Pi text/change | Reason |
|---|---|---|
| YAML frontmatter in each source agent | Rewritten to Pi subagent frontmatter: `name`, `description`, `tools: ...` | Pi `.pi/extensions/subagent` expects markdown agents with lowercase Pi tool names in comma-separated `tools` frontmatter. |
| `tools:` entries such as `Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash` | `read`, `find`, `ls`, `grep`, `write`, `edit`, `bash` | Mechanical Pi tool-name compatibility. |
| Banner: `.claude/references/rules-architecture.md` | `Pi port note: shared project workflow rules live in AGENTS.md, .pi/rules/domain.md, .pi/skills/*, and .pi/plans/pi-native-workflow-migration.md.` | Avoid active Claude-only reference while preserving the intent of pointing agents to shared workflow rules. |
| Tool descriptions/examples using `Glob(...)`, `Grep(...)`, `Read(...)`, `Write(...)`, `Edit(...)`, `Bash(...)` | Lowercase Pi-equivalent examples such as `find(...)`, `grep(...)`, `read(...)`, `write(...)`, `edit(...)`, `bash(...)` | Prevent Pi agents from attempting Claude-only tool names. |

## Agent-specific adaptations

| Agent | Source line/section | Pi text/change | Reason |
|---|---|---|---|
| `architect` | Frontmatter `mcp__context7__*`, `mcp__github__*`; Design Process step “Research existing patterns (mcp__context7__)”; Tools Available | Replaced MCP tool references with repository-evidence guidance and “request orchestrator code_search/web research if external documentation is required.” | Pi project agents do not have those Claude MCP tools; external research remains orchestrator-mediated. |
| `detective` | Frontmatter `LSP`, `mcp__playwright__*`, `mcp__context7__*`; Tools Available | Replaced with grep/find/read/targeted commands and request-orchestrator guidance for browser/external documentation needs. | Pi agent cannot directly invoke Claude LSP/MCP tools. |
| `merge-supervisor` | Phase 0 step: `bd update {BEAD_ID} --claim`; Protocol steps that committed/pushed via merge-slot and set `bd update {BEAD_ID} --status inreview`; Iron Law references to `.claude/skills/subagents-discipline/SKILL.md` | Changed to read `bd show {BEAD_ID}` and follow orchestrator context; report resolved state/recommended commit instead of committing, pushing, managing merge-slot, or changing statuses unless explicitly authorized; replaced active Claude skill references with `AGENTS.md` / `.pi/rules/domain.md`. | Avoid giving a delegated subagent orchestrator-only lifecycle authority and remove active Claude-only operational references. |
| `scout` | Frontmatter `LSP`; Tools Available and search examples | Replaced LSP with grep/find/read guidance and lowercased examples. | Pi compatibility; scout remains read-only/exploratory. |
| `scribe` | Frontmatter `Read`, `Write`, `Edit`, `Glob`; Tools Available | Lowercase Pi tools and find/ls wording. | Pi compatibility while preserving lightweight docs-writer identity. |
| `code-simplifier` | Frontmatter from standalone Claude plugin had no `tools`; body referenced `CLAUDE.md`; final paragraph said it operates autonomously/proactively | Added Pi `tools`; changed `CLAUDE.md` to `AGENTS.md`; final paragraph now says it operates only when dispatched by Pi review workflow/orchestrator and must not close beads, push, or change workflow status. | Enable actual edits through Pi tools, point to Pi source of truth, and avoid autonomous workflow/status mutations. |

## Preserved content

- Role names, identities, purposes, process descriptions, output/report formats, and quality guidance were preserved unless a Pi compatibility or workflow-safety reason is listed above.
- Natural-language occurrences such as “Read file contents” or “Read 20+ lines” remain as harmless prose, not active Claude tool invocations.
- `discovery` remains intentionally omitted.

## Verification notes

- Harmful active-instruction grep after adaptation has no Claude-only tool/MCP hits. Remaining hits are prose words (`Read`) in descriptions, not executable tool calls.
