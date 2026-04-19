# CLAUDE.md

## Context Documents

- **[.claude/codebase-map.md](.claude/codebase-map.md)** — Architecture, pages, components, composables, utils, Tauri commands, types, data flow.
- **[docs/attachments.md](docs/attachments.md)** — Attachment system (filesystem-only, `external_ref` reserved for real external refs).
- **[.claude/references/bd-knowledge.md](.claude/references/bd-knowledge.md)** — Внутреннее устройство bd: категории статусов, источники правды, custom status config, edge-cases. Читай при вопросах о bd-семантике.

> Adding a new rule / hook / skill / constraint? Read **[.claude/references/rules-architecture.md](.claude/references/rules-architecture.md)** first — 5-level lazy-loaded system (L1 root / L2 nested / L3 rules with `paths:` / L4 skills / L5 hooks).

Consult these before starting any task.

## Workflows

### Evidence before claims (Iron Law)

Completion reports (both orchestrator and supervisor) must not use hedging language: *"should work / probably / seems / looks correct / выглядит корректно / должно работать / наверное работает / вроде проходит"*. Any status claim (tests pass, build ok, bug fixed, acceptance met) requires **fresh evidence in the same message**: command run + actual output + exit code. If the command wasn't run, write the actual state ("tests not run yet"), not a guess. Celebratory phrases ("Готово!", "Perfect!") are allowed ONLY after the evidence, never instead.

Canonical wording and banned-phrase list: `.claude/skills/subagents-discipline/SKILL.md` → Iron Law section.

### Issues
- Полный справочник команд bd (создание, запросы, формулы, lifecycle, worktrees): **[.claude/references/bd-commands.md](.claude/references/bd-commands.md)**.
- **Язык**: title, description, notes, design, acceptance — **на русском**. Английскими остаются только технические идентификаторы (имена файлов/функций, label'ы, типы, статусы, команды). Это персональный трекер Максима — он читатель, не команда/CI.

### Enrich bead with context

For non-trivial beads (> 20 lines OR > 1 file), right after `bd create` add context via `bd update {ID} --notes` or `--design`: files with exact paths + line ranges, current state, target state, investigation findings, pattern reference. Short title = "what and why"; notes/design = the detailed "how and where". **Skip** for trivial fixes (< 20 lines, 1 file).

### Labels
When creating issues with `bd create`, **always** add `--label` based on which domain the issue touches. Pick 1-2 most relevant labels.

| Label | When to use | Files / domains |
|-------|-------------|-----------------|
| `frontend` | Vue components, composables, pages | `app/components/`, `app/composables/`, `app/pages/` |
| `backend` | Rust code, Tauri commands | `src-tauri/src/lib.rs`, `src-tauri/src/main.rs` |
| `tracker` | Built-in SQLite engine | `src-tauri/src/tracker/` |
| `ui` | Visual components, shadcn, themes, CSS | `app/components/ui/`, theme, styles |
| `ci` | GitHub Actions, automation | `.github/workflows/` |
| `dx` | Dev tools, tests, configs, docs | `tests/`, `vitest.config.ts`, `CLAUDE.md`, `.claude/` |
| `sync` | Sync, Dolt, git sync, polling, watcher | `useAdaptivePolling`, `useChangeDetection`, `useSyncStatus`, sync Rust code |
| `data` | Filtering, sorting, CRUD, bd-api | `bd-api.ts`, `issue-helpers.ts`, `useIssues`, `useFilters` |

Examples:
- `bd create --title="Fix Dolt badge" --type=bug --priority=3 --label=backend --label=sync`
- `bd create --title="Add column resize" --type=feature --priority=2 --label=frontend --label=ui`
- `bd create --title="Add CI workflow" --type=task --priority=2 --label=ci --label=dx`

### Типы задач (`--type`)

| Тип | Назначение | Когда использовать |
|-----|-----------|-------------------|
| `task` | Обычная задача (default) | Реализация фичи, фикс бага |
| `bug` | Баг | Воспроизводимая ошибка |
| `feature` | Фича | Новая пользовательская возможность |
| `epic` | Группа задач | Multi-domain, несколько supervisor'ов |
| `spike` | Timeboxed исследование | Неясный подход — сперва нужно исследование. Результат: решение + findings, не production-код |
| `story` | User story | Задача с точки зрения пользователя |
| `milestone` | Контрольная точка | Не содержит работы — отмечает завершение группы задач |

### Bead Status Lifecycle

bd 1.x использует структурированные статусы. Review chain отслеживается через `bd query "status=..."`.

```
open → in_progress → inreview → simplified → reviewed → accepted → closed
  ↑        ↑            ↑           ↑           ↑          ↑         ↑
create  --claim     supervisor  orchestr.   orchestr.  orchestr.  bd close
                    после push  после       после      после     --suggest-next
                                simplify    review     acceptance
```

**Кто что ставит:**
- `in_progress` → supervisor через `bd update {ID} --claim` (атомарный claim: assignee + in_progress = lock).
- `inreview` → supervisor после commit+push.
- `simplified` / `reviewed` / `accepted` / `closed` → **orchestrator** (code-simplifier / code-reviewer APPROVED / acceptance checks / `bd close --suggest-next`).

Supervisor'ы НЕ ставят `simplified`/`reviewed`/`accepted` и не вызывают `bd close` — это работа orchestrator'а. Хук `block-supervisor-close-and-signing.sh` блокирует попытки.

Сокращённые пути и fast path: **[.claude/references/review-chain.md](.claude/references/review-chain.md)**. Полный справочник команд bd + запросы + формулы: **[.claude/references/bd-commands.md](.claude/references/bd-commands.md)**.

### bd todo vs bd create

| Критерий | `bd todo add` | `bd create` |
|----------|---------------|-------------|
| Объём | < 5 строк, 1 файл | > 5 строк или multi-file |
| Supervisor нужен | Нет (orchestrator правит) | Да |
| Review chain | Нет | Да (simplified → reviewed → accepted) |
| Пример | Fix typo, update config | Новый endpoint, фикс бага |

### Merge-slot для параллельных сессий

```bash
bd merge-slot acquire           # Захватить (ждёт если занято)
git pull --rebase && git push
bd merge-slot release           # Освободить
```

Инициализация (один раз на проект): `bd merge-slot create`. Slot: `beads-task-issue-tracker-merge-slot`.

**Зачем:** без worktrees несколько сессий могут одновременно делать `git push` на одну ветку → race condition и non-fast-forward отказы. Slot гарантирует, что push сериализуется.

### Session Completion (Landing the Plane)
All steps mandatory. Work is NOT complete until `git push` succeeds.
1. File issues for remaining work.
2. Run quality gates (if code changed): `pnpm test && npx vue-tsc --noEmit`.
3. Close finished issues — `bd close <id> --suggest-next`.
4. **Update CHANGELOG.md** — entries under `[Unreleased]` for all code changes in this session.
5. Commit only files you changed: `git add file1 file2 ...` (NEVER `git add -A`/`git add .`).
6. **Push via merge-slot:**
   ```bash
   bd merge-slot acquire
   git pull --rebase && git push
   bd merge-slot release
   ```
7. Verify: `git status` must show "up to date with origin".

### Before Merge to main
**MANDATORY checklist** — do not merge without:
1. Tests pass: `pnpm test && npx vue-tsc --noEmit`.
2. `CHANGELOG.md` updated (under `[Unreleased]` or version heading).
3. `README.md` reflects any user-facing changes.
4. All beads closed.

Full merge cycle (PR → docs update → merge → checkout main) — skill `merge-to-main`.

### Testing
- **Run before committing**: `pnpm test` (Vitest unit tests).
- **Watch mode**: `pnpm test:watch`.
- Tests live in `tests/` mirroring `app/` (e.g., `tests/utils/markdown.test.ts` → `app/utils/markdown.ts`).
- Pure logic must be extracted into `app/utils/` for testability (not buried in composables).
- When adding or modifying pure logic, add or update corresponding tests.

### Code Organization
- **Never overload `app/pages/index.vue`** — extract logic into composables (`app/composables/`) and UI sections into dedicated components (`app/components/`).
- Keep `index.vue` as an orchestrator: layout structure, composable wiring, and minimal glue code.
- Prefer reusable composables over inline logic for state, dialogs, resize, filtering, etc.
- **Prefer shared components** over duplication.

### Logging
All logging rules (no `console.*` in `app/`, `logFrontend()` for TS, `log_*!` macros for Rust, log-file paths per platform) auto-load from **[.claude/rules/logging.md](.claude/rules/logging.md)** when you Read any `.ts`/`.vue`/`.rs` file.

### i18n (locale-sync)
All UI strings go through `$t('namespace.key')` (or `t(...)` from `useI18n()`); keys must stay in sync between `i18n/locales/en.json` and `ru.json`; user content and bd identifiers (status/type/priority/labels) are NOT translated. Full rules auto-load from **[.claude/rules/locale-sync.md](.claude/rules/locale-sync.md)** when you Read any `.vue`/`.ts` in `app/` or any `i18n/locales/*.json`.

### bd Version Compatibility (orchestrator-level)
- The app works with **any bd version** — Rust backend auto-detects via `parse_bd_version()` and version-gated helpers. Handles both pre-1.0 (`major == 0`) and 1.x+ (`major >= 1`).
- **bd 0.57+** uses a self-managing Dolt server; auto-flush/auto-import keeps JSONL in sync. No manual `bd sync` needed — that command no longer exists; use `bd dolt push` or `bd export`.
- Never assume all projects use Dolt — check `project_uses_dolt()` before skipping legacy paths.

Full compatibility matrix + version-gated helper list: **[src-tauri/CLAUDE.md](src-tauri/CLAUDE.md)**.

### Rust backend / Tauri
Dev Server zombie-kill, Tauri MCP setup, backend-specific patterns — auto-load from **[src-tauri/CLAUDE.md](src-tauri/CLAUDE.md)** when you touch any file in `src-tauri/`. Quick: `pnpm tauri:dev` (but kill zombies first — see src-tauri/CLAUDE.md).

### Model Selection & Completion Reports
**[.claude/references/orchestration.md](.claude/references/orchestration.md)** — DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT, когда Opus vs Sonnet.

### Releases & Commits
**[.claude/references/release-workflow.md](.claude/references/release-workflow.md)** — `./release.sh`, CHANGELOG flow, GitHub Actions artifacts, Conventional Commits (English, `Co-Authored-By: Claude Code`).

### Plan Mode
Save plans in `.claude/plans/` (local to project), never `~/.claude/plans/`. Full PLAN format: **[.claude/references/plan-mode.md](.claude/references/plan-mode.md)**.

## Permissions

### Always Allowed (no confirmation needed)
- All `bd` CLI commands.
- File operations on `.claude/` and `.beads/`.
- `~/.claude/` (global config).

### Always Require Confirmation
- `git commit`, `git push`.
