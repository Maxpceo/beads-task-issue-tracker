# PROJECT-CONTEXT.md → Pi workflow coverage

## Purpose

This note records how Claude Code delivered `PROJECT-CONTEXT.md` rules and how Pi now delivers equivalent codebase rules.

Pi source of truth is `AGENTS.md` plus `.pi/*`. `PROJECT-CONTEXT.md` and `.claude/*` remain references unless an explicit parity/migration task asks to read them.

## Claude Code consumers

| Claude file | Delivery role |
|---|---|
| `.claude/beads-workflow-injection.md` | Generic supervisor-side workflow required implementation subagents to run `cat PROJECT-CONTEXT.md` on task start. |
| `.claude/agents/vue-supervisor.md` | Required frontend supervisor to read `PROJECT-CONTEXT.md` before implementation. |
| `.claude/agents/tauri-supervisor.md` | Required backend supervisor to read `PROJECT-CONTEXT.md` before implementation. |
| `.claude/agents/test-supervisor.md` | Required test supervisor to read `PROJECT-CONTEXT.md` before implementation. |
| `.claude/agents/code-reviewer.md`, `documentation-expert.md`, `architect.md`, `detective.md`, `discovery.md`, `scout.md`, `scribe.md`, `merge-supervisor.md` | No direct `PROJECT-CONTEXT.md` read found during investigation; these roles had their own instructions/rule references and were not the direct Claude delivery path for this file. |

## Pi delivery model

| Pi path/tool | Delivery role |
|---|---|
| `.pi/rules/codebase.md` | Active Pi home for codebase rules migrated from `PROJECT-CONTEXT.md`. |
| `.pi/extensions/path-rules/index.ts` | Loads global rules: `AGENTS.md`, `.pi/rules/domain.md`, `.pi/rules/codebase.md`, plus path-scoped rule files. |
| `dispatch_supervisor` | Sends `PATH_RULES_LOADED` to implementation supervisors. |
| `dispatch_reviewer` / `review_bead` | Sends `PATH_RULES_LOADED` to `code-reviewer`. |
| `dispatch_docs_agent` | Sends `PATH_RULES_LOADED` to `documentation-expert`. |
| Generic `subagent` | Does not render path rules automatically; prompts must include relevant rules/context explicitly or use typed workflow tools when available. |

## Coverage matrix

| PROJECT-CONTEXT rule | Claude delivery path | Pi current delivery path | Gap before this change | Pi adaptation | Agents affected |
|---|---|---|---|---|---|
| Stack/version context | Required `cat PROJECT-CONTEXT.md` in Claude implementation supervisors | Partially in individual Pi agents and domain rules | Not consistent for reviewer/docs/planning agents | Added to `.pi/rules/codebase.md`, loaded globally by path-rules | supervisors, reviewer, docs, architect, detective |
| DRY / no duplicated business logic | `PROJECT-CONTEXT.md` for Claude implementation supervisors | Partial frontend organization rules in `.pi/rules/domain.md` | Cross-agent rule was incomplete | Added explicit DRY section to `.pi/rules/codebase.md` | supervisors, reviewer, architect |
| Naming conventions | `PROJECT-CONTEXT.md` for Claude implementation supervisors | Partial backend naming in `tauri-supervisor` | Vue/TS/CSS conventions not global | Added naming section to `.pi/rules/codebase.md` | supervisors, reviewer |
| Russian UI/comments/internal docs | `PROJECT-CONTEXT.md` for Claude implementation supervisors | Locale sync in `.pi/rules/domain.md`; public docs English in `AGENTS.md` | Internal comments/docs rule was unclear and could conflict with README/CHANGELOG | Added language/documentation split to `.pi/rules/codebase.md` | supervisors, reviewer, docs, architect, detective |
| No Silent Fallbacks | `PROJECT-CONTEXT.md` for Claude implementation supervisors | Partial reviewer/domain mentions | Not global for frontend/data/planning review | Added explicit no-silent-fallback rule to `.pi/rules/codebase.md` | supervisors, reviewer, detective |
| Logging | `PROJECT-CONTEXT.md` for Claude implementation supervisors | Covered in `.pi/rules/domain.md` | Delivery existed but PROJECT-CONTEXT parity was implicit | Cross-referenced from `.pi/rules/codebase.md` and kept domain as detailed source | supervisors, reviewer |
| Anti-patterns | `PROJECT-CONTEXT.md` table | Spread across Pi domain/agent prompts | Not visible as one codebase rule set | Converted key anti-patterns into `.pi/rules/codebase.md` sections | supervisors, reviewer |
| Project structure | `PROJECT-CONTEXT.md` table | Partial frontend organization in `.pi/rules/domain.md` | Missing complete path map | Added project structure table to `.pi/rules/codebase.md` | supervisors, architect, detective |
| UI/UX Tailwind/shadcn | `PROJECT-CONTEXT.md` UI/UX section | UI constraints in `.pi/rules/domain.md` | Exact Tailwind/shadcn context not global | Added UI/UX implementation section to `.pi/rules/codebase.md` | vue-supervisor, reviewer, architect |
| Documentation standards | `PROJECT-CONTEXT.md` docs section | Partial testing/docs rules only | TS/Rust JSDoc/doc comments missing | Added documentation standards to `.pi/rules/codebase.md` | supervisors, reviewer, docs |

## Active agent coverage

| Pi agent | Coverage mechanism |
|---|---|
| `vue-supervisor` | Agent prompt references Pi rule delivery; typed supervisor dispatch sends `PATH_RULES_LOADED`. |
| `tauri-supervisor` | Agent prompt references Pi rule delivery; typed supervisor dispatch sends `PATH_RULES_LOADED`. |
| `test-supervisor` | Agent prompt references Pi rule delivery; typed supervisor dispatch sends `PATH_RULES_LOADED`. |
| `code-reviewer` | Agent prompt references Pi rule delivery; `review_bead` / `dispatch_reviewer` send `PATH_RULES_LOADED`; review checklist includes codebase rules. |
| `documentation-expert` | Agent prompt references Pi rule delivery; docs dispatch sends `PATH_RULES_LOADED`; public docs remain English. |
| `architect` | New active Pi planning/design agent; reads bead when provided and treats Pi rules as source of truth. Generic subagent prompts must pass rule context when needed. |
| `detective` | New active Pi investigation agent; reads bead when provided and treats Pi rules as source of truth. Generic subagent prompts must pass rule context when needed. |

## Decision

Do not make Pi agents blindly run `cat PROJECT-CONTEXT.md`. That would keep a legacy parallel source of truth and risk divergence.

Instead, Pi owns the migrated rules in `.pi/rules/codebase.md`, and typed workflows deliver them through `PATH_RULES_LOADED`.
