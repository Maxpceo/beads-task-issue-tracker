# Agent Instructions

## Project Nature

This is a task tracker for AI-agent workflows. The human is primarily the task setter and reviewer; agents create most issue content, implementation notes, acceptance evidence, and handoff context.

Treat bd issues as durable handoff packages for future agents. Titles, descriptions, comments, plans, and acceptance evidence should be self-contained enough to continue work without chat history.

## Pi-native Workflow

For Pi sessions, the source of truth is this `AGENTS.md` file plus `.pi/*`.
`CLAUDE.md` and `.claude/*` are Claude Code workflow references and MUST NOT be modified unless the user explicitly asks for Claude Code workflow changes.

Pi workflow migration plan: `.pi/plans/pi-native-workflow-migration.md`.
Pi plans and design notes live in `.pi/plans/` or bd, not in `.claude/plans/`.
Pi rules architecture / where to place new rules: `.pi/rules/README.md`.
Pi domain rules for logging, locale sync, UI constraints, frontend review, and src-tauri/bd compatibility: `.pi/rules/domain.md`.
Pi agent contracts, reporting vocabulary, and model guidance: `.pi/agents/README.md`.
Progress is tracked in bd, not as markdown task lists.

## Pi branch naming and worktree naming

Canonical Pi task branch naming is `<type>/<bead-suffix>-<domain-or-component>-<purpose>`. `type` maps work intent to `feat` for feature work, `fix` for bugs, `docs` for docs-only changes, `test` for tests/benchmarks, `ci` for CI automation, `refactor` for refactors, `task` for workflow/general tasks, and `chore` for maintenance. The `bead-suffix` is the short suffix after the last hyphen in the bd id (`beads-task-issue-tracker-lgok` → `lgok`), not the full project bead id.

Canonical Pi worktree directory naming is the branch suffix without `<type>/`, and it must exactly match the branch suffix: branch `task/lgok-branch-worktree-naming` uses worktree basename `lgok-branch-worktree-naming`. Worktree basenames are lowercase, filesystem-safe, and descriptive enough to understand the task without opening bd.

Good examples: `feat/lgok-frontend-filtering`, `fix/lgok-sync-status`, `docs/lgok-workflow-contract`, `refactor/lgok-policy-parser`, `test/lgok-policy-coverage`, `chore/lgok-dependency-maintenance`, `ci/lgok-vitest-workflow`, `task/lgok-branch-worktree-naming`. Bad examples: `task/lgok` (missing domain/purpose), `task/beads-task-issue-tracker-lgok-branch-worktree-naming` (full bead id), `task/work` (not descriptive), worktree basename `other-name` for branch `task/lgok-branch-worktree-naming` (suffix mismatch).

This is enforced by targeted `.pi/extensions/beads-policy` validation for new task-like worktree creation under the project worktree root: `feat|fix|docs|refactor|test|chore|ci|task` branches must use the canonical branch suffix and matching worktree basename. List/remove/prune/info and non-task smoke/orphan worktrees without a task-like branch prefix remain outside this naming enforcement.

## Evidence Before Claims (Iron Law)

Completion reports and status claims must be backed by fresh evidence in the same message. Do not write hedging claims like “should work”, “probably”, “seems”, “looks correct”, “выглядит корректно”, “должно работать”, “наверное”, or “вроде проходит”.

- Claims that tests/builds/checks pass require the command, exit code, and relevant output excerpt.
- Claims that a bug is fixed or acceptance is met require the exact command/manual check and observed result.
- Before closing a non-trivial bead/epic with acceptance criteria, record an `ACCEPTANCE MATRIX:` bd comment that maps each acceptance/verification bullet to evidence, exit code or observed result, and `PASS|FAIL|NOT RUN|N/A`.
- Do not close when the matrix contains `FAIL`, `NOT RUN`, `BLOCKED`, or `SCOPE GAP` unless Maxim provides `HUMAN ACCEPTANCE OVERRIDE` with `approver:` and `reason:`.
- Prevent retry loops: after the same acceptance criterion fails twice, after two acceptance-fix cycles total, or when acceptance is blocked/not runnable without a clear local fix, stop with a concise delta report and ask Maxim for a decision instead of silently redispatching.
- If a command was not run, say so explicitly; do not imply it passed.
- Celebratory wording is allowed only after evidence, never instead of evidence.

## Proactive Best-Practice Suggestions

When working on a feature or fix and you notice a nearby best-practice improvement with clear impact, propose it before completing the task. Do not implement it without confirmation and do not expand scope silently.

Use this format: `Заметил: <что>. Почему: <best practice / concrete impact>. Делать сейчас / отдельным bead / пропустить?`

Good candidates include: accessibility labels/tooltips for icon-only controls, destructive-action confirmation, loading/empty states, focus management, form validation, debounced search/filter inputs, URL/localStorage persistence for filters, extracting pure logic to `app/utils/` with tests, removing duplication, stronger types instead of `any`, and replacing hardcoded UI strings with `$t(...)`.

Do not raise style-only or naming-only preferences unless they have a clear maintainability, accessibility, correctness, or user-impact benefit. Avoid flooding the user with minor suggestions.

## Workflow Friction / Improvement Capture

During workflow execution (`claim`, `plan`, `dispatch`, `review`, `land`, `merge-to-main`, `release`), actively watch for workflow friction that indicates the process contract can be improved. Examples:

- raw third-party stderr/warnings shown to Maxim instead of a Russian actionable workflow message;
- repeated manual recovery steps that should be a documented preflight or typed tool behavior;
- policy blocks that reveal a missing earlier guard or unclear instruction;
- mismatches between skill docs, policy behavior, typed tools, and actual command behavior;
- stale/foreign/ambiguous worktree or session-state situations that the workflow did not prevent;
- places where a command sequence had to be manually corrected during execution.

If the friction blocks the current workflow, stop with a blocker report and a concrete next action. If it does not block the current workflow, do not expand scope silently; after the current step is stable, propose it in this format:

`Заметил: <что>. Почему: <workflow impact>. Делать сейчас / отдельным bead / пропустить?`

When Maxim chooses a follow-up, create a self-contained bd issue with the relevant evidence, labels, dependencies, and out-of-scope boundaries. Keep technical command names, file paths, statuses, labels, and identifiers unchanged; user-facing explanations should be in Russian.

## Workflow Execution Style

For workflow/task execution, proceed through approved steps without intermediate permission prompts. Do not ask “continue?”, “run review?”, “push now?”, or similar when the next step is already part of the approved workflow.

Stop and ask or report status only at real decision points where user attention is required:

- code review returns `NOT APPROVED`;
- acceptance checks fail;
- fixing requires expanding scope or creating follow-up work that is not clearly in scope;
- workflow state is stale/foreign/ambiguous and takeover is not explicit;
- an unapproved destructive/hard-to-reverse action is needed.

Final workflow/task reports must start with a short human-readable summary before evidence tables:

```text
Кратко:
- Проблема: <what was wrong / why the work was needed>
- Что сделал: <1-3 concise bullets or one sentence about the change>
- Результат: <observable outcome for Maxim / workflow / user>

Проверка:
| Проверка | Результат |
|---|---|
| `<command or manual check>` | exit code N / observed result + relevant output excerpt |

Изменённые файлы:
- `path/file` — <why it changed>

Текущее состояние:
- <closed / in review / blocked / next step>
```

For bug/fix and workflow reports, `Проблема`, `Что сделал`, and `Результат` are mandatory unless the report is a tiny acknowledgement with no completed work. The evidence table is still mandatory for claims that checks passed, a fix works, acceptance is met, or workflow state changed. `Изменённые файлы` may be omitted or marked `N/A` when no repository files changed. Normal Q&A does not need this format.

Use selective workflow reporting. Full `Где мы в workflow` blocks are required when the agent stops for a decision/blocker, reports a failed required check, hands off an unresolved workflow, or finishes a user-visible workflow/task. When a full workflow block is required, place it after the `Кратко` and evidence sections; it complements the human summary and must not replace it. Routine internal checkpoints while the agent continues automatically should be omitted or compressed into one short sentence.

Do not duplicate footer state. Do not report normal `plan`, `bdStatus`, branch/worktree, or merge-slot values just because they changed; these are already visible in the Pi footer/session context. Mention them only when they are anomalous, stale/foreign/ambiguous, safety-relevant, or needed as final evidence.

When a full `Где мы в workflow` block is required, explicitly answer:

- `Текущий этап`: claim / planning / implementation / review / acceptance / landing / merge / blocked / deferred / closed.
- `Стоп или продолжаю`: whether the agent is stopping for a decision/blocker, pausing after a completed stage, or continuing automatically after an exception.
- `Причина`: why it is stopping/continuing, tied to bd status, policy, approval, failing checks, or completed evidence.
- `Следующий шаг`: the next agent action and whether any action is required from Maxim.

Use `Действие Максима: не требуется` only in final/recovery reports where saying so avoids ambiguity. Do not emit a full block solely to say no action is required.

Example blocker checkpoint:

```text
Где мы в workflow:
- Текущий этап: review guard.
- Стоп или продолжаю: стоп.
- Причина: `review_bead` недоступен, а bd status уже `inreview`; без review tool нельзя закрывать bead.
- Следующий шаг: восстановить review tool или явно подтвердить human acceptance.
- Действие Максима: выбрать один из вариантов выше.
```

Short recovery note when continuing automatically:

```text
Recovery: `gh pr merge` returned exit 1 after a local worktree checkout conflict, but PR #176 is merged and `ecc2ad8` is ancestor of `origin/main`; continuing cleanup.
```

For long-running or noisy commands (`pnpm test`, `npx vue-tsc --noEmit`, `cargo check`, `git push` hooks), filter output with `tail -N`/targeted grep where practical. Preserve exit code and the important failure/success excerpt; do not dump thousands of lines into context.

Stage and commit explicit file paths only. Do not stage whole trees with dot/all shortcuts.

bd status is the lifecycle authority for beads. Pi `workflow-state` is session-local context only: active bead binding, branch/worktree/start/end commit, `sessionMode`, plan mode/approval, and merge-slot hint. Agents use typed workflow tools as the primary path: `workflow_status`, `workflow_claim`, `workflow_reset`, `workflow_update`, `workflow_plan_mode`, `workflow_plan_approved`, and `workflow_complete` when local terminal cleanup is needed. Slash commands such as `/workflow-status`, `/workflow-claim`, `/workflow-reset`, `/workflow-update`, `/plan`, and `/plan-auto` are optional human UI shortcuts, not required agent steps. After every mutating workflow tool or blocker, provide a visible checkpoint with the observed state/tool result; do not silently stall. A checkpoint is an inline progress marker, not a stop condition: when the next workflow step is already approved or required by the active skill, continue in the same turn unless a real decision point/blocker is present.
Do not start, claim, implement, or dispatch unrelated work while the current-session active bead has a non-terminal bd status; terminal bd statuses are `closed`, `blocked`, or explicit `deferred`/handoff with a recorded reason. If bd status is `inreview`, the next action is `review-bead` / `review_bead`, not another task. If active local workflow-state is stale, foreign, or ambiguous, call `workflow_reset` or ask for explicit takeover confirmation. If a reset is performed to honor an explicit user request to switch from an open/terminal/stale bead to a named next bead, continue immediately with claiming/planning that next bead in the same turn. `land` is an explicit save/push checkpoint and `merge-to-main` is an explicit session-final PR/merge workflow; neither is an automatic per-task stage.

## Fast Path / Large Change Discipline

Fast Path is allowed only when the orchestrator explicitly judges the change to be trivial, low-risk, and cheaper than supervisor dispatch.

- Low-risk direct work: up to 3 code files and up to 80 added lines, with clear acceptance evidence.
- Threshold exceeded: continue only with an explicit `FAST_PATH_RATIONALE`/written rationale or switch to supervisor path.
- Hard supervisor path: workflow/policy/review/merge logic, `.pi/agents`, scripts, or cross-domain frontend + backend changes require an active bead and approved plan/supervisor workflow.
- Mechanical batches are allowed only with an explicit mechanical label/reason, narrow scope, and review evidence.
- Docs/beads-only maintenance should not trigger Fast Path blocks, but still needs accurate bd tracking when it creates work.

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim --json      # Claim work
bd close <id>         # Close only after review/acceptance evidence
bd dolt status        # Inspect Dolt-backed bead state when needed
bd dolt pull          # Pull bd/Dolt state when needed
bd dolt push          # Push bd/Dolt state when needed
```

Note: `bd show <id> --json` returns an array; use `jq '.[0]'`. Validate one new `bd --json | jq` shape before parallelizing similar commands.

## Landing the Plane

Use the `land` skill to save/push session work, or `merge-to-main` for PR + merge. These skills own quality gates, bd/Dolt sync, merge-slot, commit, push, cleanup, and final evidence. Work is not complete until the relevant skill reports successful push/merge; stop earlier only for a real blocker or Maxim decision.

## Permissions and Confirmation

Safe/read-only investigation does not need confirmation: reading files, searching, inspecting git/bd state, and running non-mutating checks. Mutating workflow steps that are already part of an approved bead plan or explicit skill (`land`, `merge-to-main`, `review-bead`) may proceed without intermediate prompts.

Ask before actions that are destructive, hard to reverse, or outside the approved plan, including force-push, reset, deleting worktrees/branches with uncommitted work, closing or stealing someone else’s bead, broad scope expansion, or modifying protected/secrets files.

Do not modify `CLAUDE.md`, `.claude/*`, or Claude-specific workflow files unless the user explicitly requests Claude Code workflow changes. For Pi workflow changes, update `AGENTS.md` and `.pi/*`.

`.pi/extensions/beads-policy` and related Pi policy extensions are authoritative when they block a tool call. Do not bypass policy blocks unless the user explicitly approves a documented override.

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

Bead titles, descriptions, notes, design text, acceptance criteria, and comments should be written in Russian for Maxim. Keep technical identifiers unchanged: file/function names, commands, labels, statuses, types, and API names.

Project-facing open-source text such as `CHANGELOG.md`, `README.md`, release notes, and commit messages should be written in English unless the user explicitly requests otherwise.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Self-Contained Beads

Agent-created beads must be self-contained handoff packages. A future session must be able to implement or review the task without chat history.

Before any agent-created `bd create` (new issue, follow-up, discovered bug, split scope, or documented work item), load and apply `.pi/skills/create-bead/SKILL.md`. Hand-written `bd create` commands that skip the skill checklist are not allowed. The command must keep the description visible to Pi guards, normally via inline heredoc inside `--description`; do not hide it in shell variables, wrapper scripts, or temp files.

Required description sections for non-epic, non-exempt agent-created beads:

- `### Origin`
- `### Files`
- `### Current state`
- `### Target state`
- `### Investigation findings`
- `### Decisions`
- `### Rejected alternatives`
- `### Dependencies / blockers`
- `### Acceptance criteria`
- `### Verification / acceptance checks`
- `### Out of scope`

Also required:

- Add at least one label (`--label`, `--labels`, or `-l`).
- Choose labels from the domain table below when possible.
- Add relationships when known: `parent-child:<epic-id>` for epic children, `discovered-from:<source-id>` for follow-ups, and blocker dependencies for required ordering.
- Acceptance and verification must be observable bullet checks, not vague phrases like “works”, “done”, or “fixed”.
- If acceptance is unclear, stop and ask the user one concrete question with 2-4 options before creating, dispatching, or closing the bead.
- If context is insufficient, investigate first, create an investigation bead, or ask; do not create stub tasks that rely on chat memory.

### Domain labels

When creating beads, always add 1-2 relevant labels:

| Label | When to use | Files / domains |
|---|---|---|
| `frontend` | Vue components, composables, pages | `app/components/`, `app/composables/`, `app/pages/` |
| `backend` | Rust code, Tauri commands | `src-tauri/src/` |
| `tracker` | Built-in tracker engine | `src-tauri/src/tracker/` |
| `ui` | Visual components, shadcn, themes, CSS | `app/components/ui/`, themes, styles |
| `ci` | GitHub Actions, automation | `.github/workflows/` |
| `dx` | Dev tools, tests, configs, docs | `tests/`, config files, docs, agent workflow files |
| `sync` | Sync, Dolt, polling, watcher | `useAdaptivePolling`, `useChangeDetection`, `useSyncStatus`, sync Rust code |
| `data` | Filtering, sorting, CRUD, bd API | `bd-api.ts`, `issue-helpers.ts`, `useIssues`, `useFilters` |
| `pi` | Pi workflow, skills, agents, extensions | `.pi/`, `AGENTS.md` |
| `workflow` | Lifecycle/review/merge/release policy | `.pi/skills/`, `.pi/extensions/`, workflow docs |

### `bd todo` vs full beads

Use `bd todo` only for tiny, local reminders where all of these are true:

- change is under ~5 lines and usually one file;
- no supervisor/review chain is needed;
- no self-contained handoff package is needed;
- losing rich context would not hurt a future session.

Use `bd create` with the full self-contained template for bugs, features, multi-file work, cross-domain work, anything needing review, or anything another agent may need to pick up later.

`bd todo` shortcuts are regular task issues:

```bash
bd todo add "Tiny follow-up"
bd todo list
bd todo done <id>
```

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Добавить проверку формата задач" -t bug|feature|task -p 0-4 --label dx --description "$(cat <<'EOF'
### Origin
- Запрос пользователя или исходный bead, из-за которого появилась задача.
### Files
- path/to/file.ts
### Current state
- Наблюдаемое текущее поведение.
### Target state
- Наблюдаемое целевое поведение.
### Investigation findings
- Уже собранные факты и ссылки на проверенные файлы/команды.
### Decisions
- Выбранный подход и причина выбора.
### Rejected alternatives
- Рассмотренная альтернатива и причина отказа.
### Dependencies / blockers
- parent-child:<epic-id> / discovered-from:<id> / blocks:<id> / нет.
### Acceptance criteria
- Конкретный наблюдаемый результат для приёмки.
### Verification / acceptance checks
- Команда или ручная проверка с ожидаемым результатом.
### Out of scope
- Явные не-цели задачи.
EOF
)" --json

bd create "Уточнить обработку найденной проблемы" -p 1 --label dx --deps discovered-from:bd-123 --description "$(cat <<'EOF'
### Origin
- Обнаружено в ходе работы над bd-123.
### Files
- path/to/file.ts
### Current state
- Наблюдаемое текущее поведение.
### Target state
- Наблюдаемое целевое поведение.
### Investigation findings
- Уже собранные факты и ссылки на проверенные файлы/команды.
### Decisions
- Выбранный подход и причина выбора.
### Rejected alternatives
- Рассмотренная альтернатива и причина отказа.
### Dependencies / blockers
- discovered-from:bd-123.
### Acceptance criteria
- Конкретный наблюдаемый результат для приёмки.
### Verification / acceptance checks
- Команда или ручная проверка с ожидаемым результатом.
### Out of scope
- Явные не-цели задачи.
EOF
)" --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Выполнено" --json
```

### Issue Types

Current `bd create --type` supports:

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)
- `decision` - ADR/design decision record

Claude-era references may mention `spike`, `story`, and `milestone`. Do not use those as `--type` unless current bd custom type config supports them. Until then, model them as:

- spike/research → `task` with `dx`, `backend`, `frontend`, or relevant domain labels and explicit investigation acceptance;
- story → `feature` with user-facing acceptance criteria;
- milestone → `epic` or a `decision`/documentation bead, depending on whether it contains work.

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Описать найденную проблему" --description="Кратко: что обнаружено, где воспроизводится, какой ожидаемый результат" -p 1 --label dx --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Выполнено"`

### bd 0.57+ Dolt sync

bd 0.57+ uses a self-managing Dolt server with auto-flush/auto-import. The old `bd sync` command no longer exists.

- Each write auto-commits to Dolt history.
- Use `bd dolt pull` / `bd dolt push` for remote Dolt sync when needed.
- For legacy JSONL projects, commit named `.beads/` paths explicitly instead of relying on Dolt commands.
- No manual `bd sync` step is required or available.

<!-- END BEADS INTEGRATION -->
