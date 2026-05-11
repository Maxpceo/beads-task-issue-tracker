# CLAUDE.md → Pi AGENTS.md parity matrix

Bead: `beads-task-issue-tracker-wfwu`
Date: 2026-05-11
Scope: audit only. Do not apply migration changes from this document without explicit approval.

## Summary

Recommended migration strategy: keep `AGENTS.md` as the Pi source-of-truth root, preserve Pi-native lifecycle/tooling, and port missing `CLAUDE.md` rules section-by-section into the most specific Pi surface (`AGENTS.md`, `.pi/rules/domain.md`, `.pi/skills/*`, `.pi/agents/*`). Do not replace `AGENTS.md` wholesale with `CLAUDE.md`.

Important user decision: CHANGELOG guidance should **not** be moved into `land`. It belongs in `merge-to-main` / `documentation-expert` flow. `land` is a save/push checkpoint and is not run often enough to enforce final changelog coverage.

## Legend

| Status | Meaning |
|---|---|
| `missing` | Present in `CLAUDE.md`, absent or materially incomplete in Pi source-of-truth. |
| `partial` | Some Pi equivalent exists, but important details are missing or stale. |
| `ported` | Already represented well enough in `AGENTS.md` or `.pi/*`. |
| `pi-only` | Pi-native rule with no direct Claude equivalent; keep. |
| `claude-only` | Do not port directly; translate or omit. |
| `decision` | Needs user/orchestrator decision before migration. |

## Missing or incomplete in Pi source-of-truth

| Priority | CLAUDE.md section | Current Pi status | Gap / missing rule | Recommended Pi target | Proposed Pi adaptation |
|---|---|---|---|---|---|
| P0 | `Evidence before claims (Iron Law)` | partial | `AGENTS.md` requires acceptance evidence in bead templates, but does not ban hedging language or require command + output + exit code for every status claim. | `AGENTS.md` root + agent parity contract | Add concise Iron Law: no “should work/probably/seems/looks”; every completion/test/build/fix claim needs fresh command/manual evidence + exit code/result. |
| P1 | `Project Nature` | missing | Pi root does not say this tracker is primarily for AI agents and issues/comments are mostly agent-authored. | `AGENTS.md` near top | Add context to guide style, bead descriptions, and evidence discipline. |
| P1 | `Issues` language | partial | Personal context says answer in Russian, but Pi root does not explicitly require bead titles/descriptions/notes/design/acceptance in Russian while preserving technical identifiers. | `AGENTS.md` Issue Tracking section | Add Russian bead-content rule; keep filenames/functions/commands/statuses/labels in English. |
| P1 | `Labels` table | partial | `AGENTS.md` requires at least one label but does not explain domain labels (`frontend`, `backend`, `tracker`, `ui`, `ci`, `dx`, `sync`, `data`). | `AGENTS.md` Issue Tracking section | Port label table, adapted to Pi. This improves self-contained bead creation. |
| P1 | `Workflow Execution Style` | partial | Pi skills mention some no-question behavior, but root `AGENTS.md` does not define when to proceed vs ask. | `AGENTS.md` + specific `.pi/skills/*` if needed | Add no-intermediate-question rule with allowed stop points: NOT APPROVED, failing acceptance, out-of-scope issue, destructive/hard-to-reverse action. |
| P1 | `Workflow Execution Style` final report format | partial | Some Pi skills already use two-column reports, but root `AGENTS.md` does not require it generally. | `AGENTS.md` | Add standard final report format: two-column `| Шаг | Результат |` plus short current-state section. |
| P1 | `Workflow Execution Style` long output filtering | missing | Pi root does not instruct agents to tail/filter long command output. | `AGENTS.md` | Add command-output hygiene: use `tail -N`/grep for long tests/builds/push logs; capture status and delta, not full logs. |
| P1 | `Session Completion` CHANGELOG | partial | Pi `merge-to-main` dispatches docs agent if docs required, and `documentation-expert` updates CHANGELOG for user-facing changes; root Pi guidance does not clearly state final changelog coverage. | `.pi/skills/merge-to-main/SKILL.md` + `.pi/agents/documentation-expert.md` + brief `AGENTS.md` note | Do **not** put this in `land`. Add rule: during merge-to-main, documentation expert checks whether code/user-facing changes need `CHANGELOG.md` under `[Unreleased]`; entries in English. |
| P1 | `Session Completion` `git add -A` ban | partial | `.pi/skills/land` says never use `git add .` or `git add -A`; root `AGENTS.md` does not. | `AGENTS.md` + keep land | Add root rule: commits must stage explicit paths; no `git add .` / `git add -A`. |
| P1 | `Before Merge to main` | partial | Pi `merge-to-main` has strong PR/CI/final-verdict flow but does not explicitly mention README/CHANGELOG update pre-merge in the same way. | `.pi/skills/merge-to-main/SKILL.md` | Add docs coverage condition: README/CHANGELOG updated or explicitly skipped with evidence. |
| P1 | `Testing` | partial | Tests are in some skills, but root Pi docs lack test organization guidance. | `AGENTS.md` or `.pi/rules/domain.md` | Port: `pnpm test`, `pnpm test:watch`, tests mirror `app/`, pure logic in `app/utils/` with tests. |
| P1 | `Code Organization` | partial | `vue-supervisor` has some guidance; root/domain rules do not mention `app/pages/index.vue` orchestration limit. | `.pi/rules/domain.md` + `vue-supervisor` already | Add Nuxt/Vue organization rules to domain: keep `index.vue` thin; extract composables/components/utils; prefer shared components. |
| P1 | `Proactive best-practice suggestions` | missing | Pi has Fast Path discipline but no “suggest best-practice improvement, do not implement without confirmation” rule. | `AGENTS.md` | Add scoped suggestion rule with examples; avoid scope creep. |
| P2 | `Issue types` | partial | Pi list lacks `spike`, `story`, `milestone`; current bd may or may not support all. | `AGENTS.md` after CLI verification | Add supported types only after checking `bd create --help`/current bd schema. If unsupported, document as Claude-only historical. |
| P2 | `bd todo vs bd create` | missing/decision | Pi docs do not describe `bd todo`; current bd availability should be verified. | decision after `bd todo --help` | If supported, add lightweight-vs-full-bead guidance. If not, omit and note unsupported. |
| P2 | `Model Selection & Completion Reports` | partial | Pi agents have status vocabulary, but root does not describe when to use high-capability models/subagents or report vocabulary globally. | `.pi/agents/README.md` + `AGENTS.md` short note | Port status vocabulary and model-selection guidance in Pi terms, not Claude Opus/Sonnet names unless Pi model aliases exist. |
| P2 | `Plan Mode` | partial | Pi `plan-bead` exists but root does not say where durable plans live. | `.pi/skills/plan-bead/SKILL.md` | Clarify: plans/progress go in bd comments; design docs in `.pi/plans` or `.designs` when appropriate, not `.claude/plans`. |
| P2 | `Permissions` | partial | Pi has policy extensions, but root lacks human-readable allowed/confirm list. | `AGENTS.md` + maybe `.pi/extensions/beads-policy` docs | Add Pi-specific allowed/confirmation guidance; do not copy Claude permissions literally. |
| P2 | `Context Documents` | partial | `AGENTS.md` points to `.pi/plans` and `.pi/rules/domain.md`, but misses docs like attachments/bd knowledge or maps. | `AGENTS.md` | Add Pi references only if they exist; otherwise list Claude docs as read-only references with Pi adaptation caution. |
| P3 | `Releases & Commits` | partial | Pi has `release` skill, but root does not mention conventional commits/release docs. | `.pi/skills/release/SKILL.md` + optional `AGENTS.md` note | Port only release-relevant rules; do not add `Co-Authored-By: Claude Code` to Pi. |
| P3 | `Rust backend / Tauri` | partial | `.pi/rules/domain.md` has bd compatibility and dev startup, but `tauri-supervisor` still references `src-tauri/CLAUDE.md` as backend reference. | `.pi/rules/domain.md` + future backend Pi rule file | Consider porting backend/Tauri details from `src-tauri/CLAUDE.md` into Pi rules in a separate task. |

## Extra, stale, or risky in AGENTS.md

| Priority | AGENTS.md item | Issue | Recommended action |
|---|---|---|---|
| P1 | Quick reference `bd close <id> # Complete work` | Too easy to interpret as direct close. Pi/Claude review lifecycle requires review/acceptance evidence before close. | Change to “Close only after review/acceptance evidence” or move close command under review workflow guidance. |
| P1 | Quick reference `bd update <id> --status in_progress` | Less precise than claim workflow and bypasses assignee semantics. | Prefer `bd update <id> --claim --json`. |
| P1 | `Landing the Plane` says push is mandatory at session end | Useful but too broad unless tied to explicit `land`; Pi workflow says `land` is explicit and not automatic per bead. | Clarify: mandatory when user invokes `land`/session completion; not every closed bead requires immediate land. |
| P1 | `Landing the Plane` includes `bd dolt pull/push || true` then merge-slot push | Current targeted fix is better than `bd sync`, but `|| true` can hide bead sync failures. | Decide whether `|| true` is acceptable or should be “run and record failures; legacy JSONL may skip with reason”. |
| P1 | Large self-contained bead template inline | Root file is noisy and duplicates examples. | Keep required sections, but consider moving full examples to `.pi/templates` or `.pi/rules/beads.md`. |
| P2 | Generic priority/type list | Does not match richer Claude type list and may not reflect current bd CLI exactly. | Verify current bd supported types/priorities; sync docs. |
| P2 | “No manual export/import needed!” was removed in targeted fix | Good removal; in legacy JSONL projects export/commit may be needed. | Keep current more precise Dolt/legacy split. |
| P2 | `For more details, see README.md and docs/QUICKSTART.md` | May point to generic bd docs not project Pi workflow. | Add project-specific Pi docs first, external/general docs second. |
| P3 | `Run bd onboard` | Harmless but may be redundant for established repo. | Keep as generic bd note or move lower. |

## Already ported well enough

| CLAUDE.md section | Pi location | Notes |
|---|---|---|
| Logging | `.pi/rules/domain.md` | Ported as Pi-native logging rules. |
| i18n / locale sync | `.pi/rules/domain.md` | Ported with en/ru parity check. |
| bd 0.57+ compatibility | `AGENTS.md`, `.pi/rules/domain.md` after targeted fix | Active `bd sync` commands removed; negative mentions remain intentionally. |
| Frontend review replacing RAMS/WIG | `.pi/rules/domain.md`, `.pi/skills/review-bead/SKILL.md`, `.pi/agents/code-reviewer.md` | Pi-specific checklist is the right replacement. |
| Merge-slot basics | `.pi/skills/land/SKILL.md`, `.pi/skills/merge-to-main/SKILL.md`, `AGENTS.md` | Present; can be made more consistent. |
| Review chain | `.pi/skills/review-bead/SKILL.md`, `.pi/extensions/review-workflow`, `AGENTS.md` | Present; some wording may need update after code-simplifier workflow lands. |
| Fast path / large change discipline | `AGENTS.md`, `.pi/extensions/beads-policy` | Pi-only improvement; keep. |
| Epic management | `.pi/skills/managing-epics/SKILL.md` | Pi-native and more detailed than root Claude docs. |
| Documentation expert for docs/CHANGELOG | `.pi/agents/documentation-expert.md`, `.pi/skills/merge-to-main/SKILL.md` | Present but should explicitly align with user decision: CHANGELOG belongs in merge-to-main/docs flow, not land. |

## Claude-only or translate-before-port

| CLAUDE.md item | Decision | Pi adaptation |
|---|---|---|
| `.claude/skills/*` authoritative skill paths | Do not copy literally | Map to `.pi/skills/*` names. |
| `Task(...)` dispatch | Claude-only | Use `dispatch_supervisor`, `dispatch_reviewer`, `review_bead`, `dispatch_docs_agent`, or `subagent`. |
| Claude hooks (`*.sh`, hook names) | Do not copy literally as active mechanisms | Map to `.pi/extensions/beads-policy`, plan-mode, workflow-state, etc., or document as historical reference. |
| RAMS/WIG | Do not port | Use Pi Frontend Review Checklist. |
| `.claude/plans/` | Do not port | Use bd comments, `.pi/plans/`, or `.designs/` depending on artifact type. |
| `Co-Authored-By: Claude Code` | Do not port | Omit unless a Pi-specific convention is later defined. |
| `~/.claude/` permissions | Do not port | Replace with Pi config/tool permissions if needed. |
| Auto-loading `.claude/rules/*` based on file reads | Do not port literally | Pi equivalent should be `.pi/rules/domain.md` and path-rules extension. |

## Decision-needed items before migration

| Question | Why it matters | Recommended default |
|---|---|---|
| Should `AGENTS.md` remain concise with detailed rules split into `.pi/rules/*.md`? | Avoid another oversized stale root file. | Yes: root for must-know workflow, `.pi/rules` for domain details. |
| Should full bead template examples stay in `AGENTS.md`? | They are useful but noisy. | Keep required sections in root; move long examples to `.pi/templates` or `.pi/rules/beads.md`. |
| Is `bd todo` available in current bd? | Determines whether Claude `bd todo vs bd create` can be ported. | Verify CLI before port. |
| Should `bd dolt pull/push || true` be allowed in mandatory workflows? | `|| true` avoids legacy failure but may hide real sync errors. | Prefer explicit “run, record exit, skip with reason for legacy/non-Dolt”. |
| Should CHANGELOG be required for every code change or only user-facing/release-notable changes? | User says CHANGELOG should be written after any code change, but also says Claude usually did it at merge-to-main via documentation expert. | Enforce in `merge-to-main` docs phase: docs expert must inspect all code changes and either update CHANGELOG or record a skip reason. Do not put in `land`. |
| Should final report format be global or only workflow skills? | Global enforcement can make small answers verbose. | Apply to workflow/task completion reports; normal Q&A can stay concise. |
| Should permissions be documented in root or rely on Pi policy extensions? | Human-readable rules prevent confusion. | Add concise root section plus refer to `.pi/extensions/beads-policy`. |

## Proposed migration batches after approval

| Batch | Scope | Files | Risk |
|---|---|---|---|
| 1 | Root workflow hygiene: Iron Law, Russian bead content, no-intermediate-question rule, final report format, long output filtering, explicit path staging. | `AGENTS.md` | Medium |
| 2 | Bead metadata parity: labels table, supported issue types after CLI verification, maybe move long templates. | `AGENTS.md`, optional `.pi/rules/beads.md` or `.pi/templates/*` | Medium |
| 3 | Merge/docs parity: CHANGELOG/README coverage in merge-to-main and documentation expert, not land. | `.pi/skills/merge-to-main/SKILL.md`, `.pi/agents/documentation-expert.md`, brief `AGENTS.md` note | Medium |
| 4 | Domain parity: testing/code organization and backend/Tauri details. | `.pi/rules/domain.md`, maybe new `.pi/rules/frontend.md` / `.pi/rules/backend.md` | Medium |
| 5 | Permissions/model/reporting parity. | `AGENTS.md`, `.pi/agents/README.md` | Low/Medium |

## Immediate recommendation

Do not rewrite `AGENTS.md` wholesale. Approve Batch 1 first, then proceed batch-by-batch with review evidence. This reduces the chance of importing Claude-only instructions or deleting Pi-native workflow controls.
