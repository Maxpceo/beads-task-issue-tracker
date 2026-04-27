# CLAUDE.md

## Project Nature

Трекер задач **для AI-агентов** (Claude Code, supervisor'ы, reviewer'ы). Человек — постановщик; **~99% контента** в issues (title, description, notes, design, acceptance, comments) заполняют агенты.

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

### Proactive best-practice suggestions

Когда работаешь над фичей или фиксом и замечаешь рядом возможность улучшения, соответствующую best practice — **предложи** её отдельным сообщением до завершения задачи. Не реализуй без подтверждения, scope не раздувай.

Что считается best practice (примеры, не исчерпывающий список):

- **Фильтры/поиск**: debounce на input, persist в URL/localStorage, «Clear all», empty state, сохранение при смене проекта, keyboard navigation.
- **UI**: `aria-label` + tooltip для icon-only кнопок, confirm-диалог для destructive действий, loading/skeleton для длинных операций, empty state когда данных нет, focus management в формах и диалогах, валидация форм.
- **Код**: extract pure logic в `app/utils/` + тесты, устранение дублирования, типобезопасность вместо `any`, мемоизация горячих computed, разбиение раздутых компонентов.
- **A11y / i18n**: контраст, role/aria, `$t(...)` вместо хардкода строк.

Формат предложения: «Заметил: <что>. Почему: <best practice / конкретное влияние>. Делать сейчас / отдельным bead / пропустить?»

Молчать, если это вкусовщина (стиль, нейминг без ясного выигрыша) или вне scope текущей задачи без видимого влияния. Не превращать каждый ответ в поток мелких замечаний — фильтр «best practice + видимое влияние».

### Issues

- Полный справочник команд bd (синтаксис CLI): **[.claude/references/bd-commands.md](.claude/references/bd-commands.md)**. Worktree policy и external layout: **[.claude/references/bd-worktrees.md](.claude/references/bd-worktrees.md)**.
- **Язык**: title, description, notes, design, acceptance — **на русском**. Английскими остаются только технические идентификаторы (имена файлов/функций, label'ы, типы, статусы, команды). Это персональный трекер Максима — он читатель, не команда/CI.

### Enrich bead with context

Полный heredoc-шаблон (`### Files` / `### Current state` / `### Target state` markers) + примеры + override — **[.claude/references/workflow-templates.md §1](.claude/references/workflow-templates.md)**. Hook `enforce-bead-enrichment.sh` блокирует `bd create` без markers (exempt: `--type=epic`, `--ephemeral`, `--from-markdown`/`--from-graph`/`--file`). Также блокирует Task→supervisor без enrich + PLAN-comment. Override: `SKIP_ENRICH_CHECK=1`.

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

bd 1.x lifecycle: `open → in_progress → inreview → simplified → reviewed → accepted → closed`. Supervisor ставит `in_progress` (через `--claim`) и `inreview` (после commit+push); orchestrator — `simplified`/`reviewed`/`accepted`/`closed` через skill **`reviewing-code`**. Хук `block-supervisor-close-and-signing.sh` блокирует попытки supervisor'ов вызывать `bd close` или ставить orchestrator-статусы.

Сокращённые пути, fast path и hook-детали: **[.claude/references/review-chain.md](.claude/references/review-chain.md)**. Полный справочник команд: **[.claude/references/bd-commands.md](.claude/references/bd-commands.md)**.

### bd todo vs bd create

| Критерий | `bd todo add` | `bd create` |
|----------|---------------|-------------|
| Объём | < 5 строк, 1 файл | > 5 строк или multi-file |
| Supervisor нужен | Нет (orchestrator правит) | Да |
| Review chain | Нет | Да (simplified → reviewed → accepted) |
| Пример | Fix typo, update config | Новый endpoint, фикс бага |

### Merge-slot для параллельных сессий

Merge-slot сериализует `git push` между параллельными сессиями (без него гонка → non-fast-forward). Commit+push внутри сессии — skill **`land`**. Финальный PR → merge в main — skill **`merge-to-main`**. Инициализация: `bd merge-slot create` (один раз на проект). Stale worktree guard (`enforce-worktree-fresh-vs-main.sh`, escape `CLAUDE_SKIP_STALE_CHECK=1`) + детали worktrees: **[.claude/references/bd-worktrees.md](.claude/references/bd-worktrees.md)**.

### Session Completion (Landing the Plane)

Завершение сессии (close beads, quality gates, commit, push via merge-slot) — skill **`land`**. Quality gates: `pnpm test && npx vue-tsc --noEmit`. CHANGELOG.md обязателен под `[Unreleased]` для всех code-изменений — **пиши записи на английском** (в отличие от bead issues, которые на русском: это open-source convention, и CHANGELOG.md / README.md / commit messages — единственные места в проекте, где контент строго English). Hook `block-git-add-all.sh` запрещает `git add -A`/`git add .` — указывай файлы по именам.

### Before Merge to main

Перед merge в main: tests pass, CHANGELOG + README обновлены (если user-facing), все beads закрыты. Полный цикл (PR → docs update → merge → checkout main) — skill **`merge-to-main`**.

### Workflow Skills

Auto-trigger по триггер-фразам, процедуры в `.claude/skills/`:

- **`claiming-bead`** — «возьми <ID>», «делай <ID>», «автономно <ID>»: claim + auto Plan Mode.
- **`pre-dispatch`** — после approved плана: собирает BRANCH/START_COMMIT, выбирает supervisor'а и **немедленно вызывает** `Task(...)` inline без промежуточного вопроса.
- **`managing-epics`** — «создай эпик», «cross-domain задача»: design doc → children → sequential dispatch.
- **`reviewing-code`** — bead в `inreview` / «запусти ревью»: simplify → review → RAMS/WIG → locale-sync → acceptance → close.
- **`land`** — «пора заканчивать», «я закончил»: close beads → commit → push via merge-slot.
- **`merge-to-main`** — «мержим в main», «давай PR»: feature-ветка → commit + push (Step 1) → PR → update docs → merge → checkout main. Запускать `/land` перед ним не нужно — skill сам коммитит dirty tree и пушит ветку в Step 1.
- **`release`** — «сделай релиз», «пора релизить»: pre-flight → curated `### Highlights` в CHANGELOG → preview release body → handoff на `./release.sh`.

### Workflow Execution Style

Правила применимы ко ВСЕМ workflow-skills выше — как к шагам **внутри** одного skill'а, так и к **переходам между skill'ами** (в частности: supervisor вернул `DONE` → сразу запускай `reviewing-code`; push успешен → сразу финальный отчёт, не «что дальше?»).

**1. Без промежуточных вопросов.** Прогоняй все шаги подряд. Не спрашивай «запускать следующий шаг?», «продолжить?», «перейти к review?», «запускать ревью сейчас?». Промежуточный статус не выводи — ход работы виден по tool calls. Прерывайся вопросом ТОЛЬКО на реальной точке решения вне плана:

- code-reviewer вернул `NOT APPROVED` → redispatch supervisor или force-accept?
- acceptance-проверка провалилась → что делать дальше?
- проблема вне scope'а → расширять scope или отложить в follow-up bead?
- destructive / hard-to-reverse действие (`push --force`, `reset --hard`, `bd close` чужого бида, `git worktree remove` с uncommitted), не согласованное заранее.

Переходы, которые **НЕ** требуют вопроса: approved plan → Task dispatch, simplify→code-review, supervisor DONE→reviewing-code, code-review APPROVED→acceptance, acceptance→close, close→land, land→merge-to-main, merge-to-main→checkout main.

**2. Формат итогового отчёта workflow-skill'а** — markdown-таблица `| Шаг | Результат |` (две колонки) + короткая секция «Текущее состояние» после неё. В правой колонке — краткий итог: exit codes (`373/373 passed`), commit IDs, PR-ссылки, verdict (APPROVED/NOT APPROVED), статусы (PASSED/SKIP/N/A). Без preamble («Отлично! Готово!»), без эмодзи, без длинных параграфов.

**3. Фильтруй длинный вывод инструментов.** `pnpm test`, `npx vue-tsc --noEmit`, `git push` с pre-push-хуками, `cargo check` могут вывалить сотни-тысячи строк — они целиком попадают в контекст и жгут токены. Заворачивай в `2>&1 | tail -N` или `grep -E '(passed|failed|error|ok|✓|✗)'`. В контексте нужен статус + дельта, не полный лог.

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

Dev Server zombie-kill, Tauri MCP setup, backend-specific patterns — auto-load from **[src-tauri/CLAUDE.md](src-tauri/CLAUDE.md)** when you touch any file in `src-tauri/`. Quick: `./start-dev.sh` (or `pnpm tauri:dev` for minimal start).

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
