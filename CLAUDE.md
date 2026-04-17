# CLAUDE.md

## Context Documents

- **[.claude/codebase-map.md](.claude/codebase-map.md)** — Architecture, all pages, components, composables, utils, Tauri commands, types, data flow
- **[docs/attachments.md](docs/attachments.md)** — Attachment system (filesystem-only, `external_ref` reserved for real external refs)

Consult these before starting any task.

## Workflows

### Evidence before claims

Completion reports (both orchestrator and supervisor) must not use hedging language: *"should work / probably / seems / looks correct / выглядит корректно / должно работать / наверное работает / вроде проходит"*. Any status claim (tests pass, build ok, bug fixed, acceptance met) requires **fresh evidence in the same message**: command run + actual output + exit code. If the command wasn't run, write the actual state ("tests not run yet"), not a guess. Celebratory phrases ("Готово!", "Perfect!") are allowed ONLY after the evidence, never instead.

Canonical wording and banned-phrase list: `.claude/skills/subagents-discipline/SKILL.md` → Iron Law section.

### Issues
- `/run-issue <id>` — Always run before starting work on any issue
- `/close-issue` — Always ask confirmation before closing
- `/review-to-commit` — Always use when user asks to commit

### Enrich bead with context

For non-trivial beads (> 20 lines OR > 1 file), right after `bd create` add implementation context via `bd update {ID} --notes` or `--design` (or `bd create --notes`/`--design` in one call):

- **Files:** exact paths + line ranges (`src-tauri/src/lib.rs:123-145`)
- **Current state:** what's there now (snippet, behavior, contract)
- **Target state:** what it should become (snippet, expected behavior)
- **Investigation findings:** what you already checked (grep results, linked beads) — so the supervisor doesn't re-investigate
- **Pattern reference:** working analogue elsewhere in the project, if any

Short title = "what and why". Notes/design = the detailed "how and where". Goal: a future session picks up the bead and works WITHOUT repeating the investigation.

**Skip** for trivial fixes (< 20 lines, 1 file) — title alone is enough.

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

bd v1.0.2 использует структурированные статусы вместо comment markers. Весь review chain отслеживается через `bd query "status=..."`:

```
open → in_progress → inreview → simplified → reviewed → accepted → closed
  ↑        ↑            ↑           ↑           ↑          ↑         ↑
create  --claim     supervisor  orchestr.   orchestr.  orchestr.  bd close
                    после push  после       после      после     --suggest-next
                                simplify    review     acceptance
```

**Кто что ставит:**
- `in_progress` → supervisor через `bd update {ID} --claim` (атомарный claim: assignee + in_progress). Это lock — предотвращает захват бида другим агентом.
- `inreview` → supervisor после commit+push
- `simplified` → **orchestrator** после code-simplifier
- `reviewed` → **orchestrator** после code-reviewer APPROVED
- `accepted` → **orchestrator** после acceptance checks
- `closed` → **orchestrator** через `bd close {ID} --suggest-next`

Supervisor'ы НЕ ставят `simplified`/`reviewed`/`accepted` и не вызывают `bd close` — это работа orchestrator'а. Хук `block-supervisor-close-and-signing.sh` блокирует попытки.

**Сокращённые пути:**
- Без `acceptance_criteria`: `reviewed → closed` (skip `accepted`)
- Fast path: `open → in_progress → closed` (skip весь review chain)

### Beads Commands (reference)

```bash
# Discovery & query
bd ready                                          # Беды без блокеров — что брать в работу
bd query "status=open AND priority<=2"            # Язык запросов: AND/OR/NOT, сравнения, даты
bd list --status=in_progress                      # Фильтр по статусу
bd show {ID} [--json]                             # Детали (human или JSON)
bd graph {ID}                                     # Визуализация зависимостей
bd graph --html {ID} > g.html                     # Интерактивный HTML
bd graph check                                    # Проверка целостности графа
bd stats                                          # Общая статистика (open/closed/blocked)
bd find-duplicates [--method ai]                  # Поиск дубликатов (механический/AI)
bd preflight                                      # Pre-PR checks (lint + stale + orphans)
bd stale                                          # Бид без активности
bd orphans                                        # Бид со сломанными зависимостями

# Create & update
bd create --title="..." --description="..." --type=task --priority=2 --label=dx
bd create --title="..." --type=epic               # Эпик (родитель)
bd create --title="..." --parent={EPIC_ID}        # Child эпика
bd q "Title" -p 1                                 # Quick capture (выводит только ID)
bd update {ID} --claim                            # Атомарный claim (assignee + in_progress)
bd update {ID} --status inreview                  # Явный статус
bd update {ID} --acceptance "1. Тесты. 2. ..."    # Acceptance criteria
bd update {ID} --notes / --design / --title       # Поля бида

# Todo (лёгкие задачи)
bd todo add "Fix typo"                            # Создать (P2 task)
bd todo                                           # Список открытых
bd todo done {ID}                                 # Закрыть

# Close
bd close {ID}                                     # Закрыть
bd close {ID1} {ID2} ...                          # Массово (эффективнее)
bd close {ID} --suggest-next                      # + показать разблокированные
bd close {ID} --claim-next                        # + сразу взять следующую

# Dependencies
bd dep add {ID} {DEPENDS_ON}                      # Добавить зависимость
bd dep relate {NEW_ID} {OLD_ID}                   # Трассировка без зависимости
bd blocked                                        # Все заблокированные

# Formulas & batch
bd formula list                                   # Доступные формулы
bd mol pour <name> --var key="value"              # Создать эпик из формулы
bd mol distill {EPIC_ID} name                     # Извлечь формулу из удачного эпика
bd cook <name> --dry-run --var key="v"            # Предпросмотр без создания
bd batch -f operations.txt                        # Атомарные операции из файла

# State & parallel work
bd set-state {ID} dim=value --reason "why"        # Оперативное состояние
bd worktree create name --branch branch           # Worktree для параллельной работы
bd merge-slot acquire / release                   # Сериализация push (см. ниже)

# Lifecycle hygiene
bd defer {ID} --until="date"                      # Отложить до даты
bd supersede {ID} --with={NEW_ID}                 # Заменить новым
bd gc --dry-run                                   # Сборка мусора (предпросмотр)
bd human {ID}                                     # Флаг для человеческого решения
bd memories <keyword> / bd remember / bd forget   # Persistent memory
```

### Полезные запросы (bd query)

Язык запросов: AND/OR/NOT, сравнения (`=`, `!=`, `<=`, `>`), даты (`>2d`, `>7d`).

```bash
bd query "status=open AND priority<=2"             # Приоритетные открытые
bd query "status=open AND type=bug"                # Открытые баги
bd query "status=inreview"                         # Ждут simplify
bd query "status=simplified"                       # Ждут code review
bd query "status=reviewed"                         # Ждут acceptance
bd query "status=inreview AND updated>2d"          # Застряли в review chain
bd query "label=frontend AND status!=closed"       # Активные фронтенд задачи
bd query "assignee=none AND status=open"           # Ничьи задачи
bd query "type=epic AND status!=closed"            # Активные эпики
bd query "status=in_progress AND updated>7d"       # Застрявшие >7 дней
```

### bd todo vs bd create

| Критерий | `bd todo add` | `bd create` |
|----------|---------------|-------------|
| Объём | < 5 строк, 1 файл | > 5 строк или multi-file |
| Supervisor нужен | Нет (orchestrator правит) | Да |
| Review chain | Нет | Да (simplified → reviewed → accepted) |
| Пример | Fix typo, update config | Новый endpoint, фикс бага |

### Формулы для типовых задач

3 готовых формулы в `.beads/formulas/` (адаптированы под Vue/Nuxt + Tauri):

```bash
bd formula list                                                         # Список
bd mol pour vue-feature --var feature_name="Dashboard"                  # component → composable → integration
bd mol pour tauri-feature --var feature_name="Auth"                     # Rust cmd → bridge → Vue hook
bd mol pour bug-fix --var bug="Login timeout"                           # reproduce → fix → regression test
bd cook vue-feature --dry-run --var feature_name="X"                    # Предпросмотр без создания
bd mol distill {EPIC_ID} my-new-formula                                 # Извлечь формулу из удачного эпика
```

### Merge-slot для параллельных сессий

При параллельных сессиях Claude Code — использовать merge-slot для сериализации push на одной ветке:

```bash
bd merge-slot acquire           # Захватить (ждёт если занято)
git pull --rebase && git push
bd merge-slot release           # Освободить
```

Инициализация (один раз на проект): `bd merge-slot create`. Slot: `beads-task-issue-tracker-merge-slot`.

**Зачем:** без worktrees несколько сессий могут одновременно делать `git push` на одну ветку → race condition и non-fast-forward отказы. Slot гарантирует, что push сериализуется.

### Session Completion (Landing the Plane)
All steps mandatory. Work is NOT complete until `git push` succeeds.
1. File issues for remaining work
2. Run quality gates (if code changed): `pnpm test && npx vue-tsc --noEmit`
3. Close finished issues — use `bd close <id> --suggest-next` to see newly unblocked beads
4. **Update CHANGELOG.md** — add entries under `[Unreleased]` for all code changes in this session
5. Commit only files you changed: `git add file1 file2 ...` (NEVER `git add -A`/`git add .` — parallel sessions may run on the same branch)
6. **Push via merge-slot** (serialises concurrent sessions):
   ```bash
   bd merge-slot acquire
   git pull --rebase && git push
   bd merge-slot release
   ```
7. Verify: `git status` must show "up to date with origin"

### Before Merge to main
**MANDATORY checklist** — do not merge without completing:
1. All tests pass: `pnpm test && npx vue-tsc --noEmit`
2. `CHANGELOG.md` updated with all changes (under `[Unreleased]` or version heading)
3. `README.md` reflects any user-facing changes (new features, new commands, etc.)
4. All beads closed

### Testing
- **Run before committing**: `pnpm test` — runs all Vitest unit tests
- **Watch mode**: `pnpm test:watch` — for development
- Tests live in `tests/` mirroring `app/` structure (e.g., `tests/utils/markdown.test.ts` → `app/utils/markdown.ts`)
- Pure logic must be extracted into `app/utils/` for testability (not buried in composables)
- When adding or modifying pure logic (filtering, sorting, parsing, transformations), add or update corresponding tests

### Code Organization
- **Never overload `app/pages/index.vue`** — extract logic into composables (`app/composables/`) and UI sections into dedicated components (`app/components/`)
- Keep `index.vue` as an orchestrator: layout structure, composable wiring, and minimal glue code
- Prefer reusable composables over inline logic for state, dialogs, resize, filtering, etc.
- **Prefer shared components** over duplication — if a UI element is used in multiple places, extract it into a shared component

### Context Management
- **Always prefer `/continue-task` over `/compact`** — it preserves issue context, progress, and next steps far better
- When the session is long and context is getting large, proactively run `/continue-task` before auto-compact triggers
- If a `PreCompact` hook fires with "auto" trigger, immediately run `/continue-task` instead of letting compact proceed blindly

### bd Version Compatibility
- **The app works with any bd version** — the Rust backend auto-detects the installed bd version via `parse_bd_version()` and adapts behavior through version-gated helpers (`supports_daemon_flag()`, `uses_jsonl_files()`, `supports_list_all_flag()`, `supports_delete_hard_flag()`, `uses_dolt_backend()`, `project_uses_dolt()`). All helpers handle both `major == 0` (pre-1.0) and `major >= 1` (1.x+) correctly.
- **bd 0.57+ uses a self-managing Dolt server** — `dolt sql-server` starts automatically on first command, no manual lifecycle management needed. This resolved the regressions from bd 0.50–0.56 that we reported in [upstream issue #2050](https://github.com/steveyegge/beads/issues/2050) (now closed/fixed).
- **JSONL stays in sync automatically** — bd 0.57+ has auto-flush (Dolt → `issues.jsonl` after each mutation, 5s debounce) and auto-import (JSONL → Dolt when file is newer). No manual export or sync hooks needed.
- **`bd sync` no longer exists** — replaced by auto-flush/auto-import and `bd export`/`bd import`. Session Completion step uses `bd dolt push` if Dolt remote is configured; otherwise JSONL is committed with git.
- **The branch `feat/bd-056-server-mode`** is obsolete — its work (server mode detection, adaptive polling, DoltServerBanner) was superseded by bd's native self-managing server. The branch can be deleted.

### bd Backward Compatibility
- Never assume all projects use Dolt — check `project_uses_dolt()` before skipping legacy paths
- Use version-gated helpers in `src-tauri/src/lib.rs` for any feature that depends on a specific bd version
- When adding new version-gated behavior, ensure both `major == 0` and `major >= 1` paths are covered

### Logging
- **Never use `console.*`** in `app/` — the only exception is `app/plugins/console-to-log.client.ts` (the interceptor itself).
- **Why**: In Tauri release builds, DevTools are disabled. The only user-facing log viewer is the in-app DebugPanel (Cmd+L), which reads `beads.log` via the Rust backend. Any `console.*` output is invisible to the end user.
- **Frontend (TypeScript)**: `logFrontend(level, '[context] message')` — import from `~/utils/bd-api`. Calls the Rust `log_frontend` Tauri command.
  - Levels: `'error'`, `'warn'`, `'info'`, `'debug'`
  - `'debug'` is gated by the Verbose toggle in DebugPanel — messages only appear in `beads.log` when Verbose is ON. Use for high-frequency diagnostics with rate-limiting.
  - Always append `.catch(() => {})` — if IPC is broken, fail silently (the app is likely broken anyway).
- **Backend (Rust)**: `log_info!("[context] message")`, `log_error!(...)`, `log_warn!(...)`, `log_debug!(...)` macros — write directly to the native log. `log_debug!` requires both `LOGGING_ENABLED` and `VERBOSE_LOGGING`.
- **Log file** (per platform):
  - **macOS**: `~/Library/Logs/com.beads.manager/beads.log` — readable via `tail -f` or in the app.
  - **Linux**: `~/.local/share/com.beads.manager/logs/beads.log` (XDG, matches `tauri-plugin-log`)
  - **Windows**: `%APPDATA%/com.beads.manager/logs/beads.log`

### Dev Server
Always kill zombies before starting: `pkill -f "$(pwd)/src-tauri/target/debug/beads-issue-tracker" 2>/dev/null && pnpm tauri:dev`

Note: scope the `pkill` match to the dev binary path. A bare `pkill -f "beads-issue-tracker"` also kills the installed `/Applications/Beads Task-Issue Tracker.app` because both binaries share the same executable name (`beads-issue-tracker` from the Cargo crate).

### AI-Driven UI Testing (Tauri MCP)

Chrome DevTools / Playwright **do not work with Tauri's WKWebView on macOS** — Apple does not implement CDP. To let Claude Code drive the running app (DOM, screenshots, clicks, JS exec, native mac mouse/keyboard), the project ships [`tauri-plugin-mcp`](https://github.com/P3GLEG/tauri-plugin-mcp) gated behind the `dev-mcp` Cargo feature (see `src-tauri/Cargo.toml` `[features]` and `src-tauri/src/lib.rs` `setup()` gated by `#[cfg(feature = "dev-mcp")]`). The `pnpm tauri:dev` script passes `--features dev-mcp` automatically; `tauri build` does not, so release binaries omit the plugin entirely — it is not linked at all.

To use it locally:
1. Install the MCP-server bridge once: `npm i -g tauri-plugin-mcp-server`. Note: this npm package's `bin` is shipped as a JS file with **no shebang**, so we cannot exec it directly — `.mcp.json` invokes it via `node` with the full `index.js` path (already wired)
2. Start the app: `pnpm tauri:dev` (the plugin auto-starts inside the dev binary; the Rust side is configured to bind to literal `/tmp/tauri-mcp.sock` because the npm bridge hard-codes that path and ignores `$TMPDIR`)
3. `.mcp.json` exposes the MCP server (already wired — `command: "node"`, `args: ["/opt/homebrew/lib/node_modules/tauri-plugin-mcp-server/build/index.js"]`). Verify with `claude mcp list` — expect `tauri: ✓ Connected`. If you see `Failed to connect`, check that `/tmp/tauri-mcp.sock` exists (the dev binary creates it at startup)
4. Ask Claude things like: "Take a screenshot of the app", "Click the Type filter and tell me the options", "Read the contents of localStorage key `beads:proj:*`"

Verification examples for upcoming features should prefer this over asking the human to look at the screen.

### Model Selection

Pick the least powerful model that can do the job — saves time and cost. When dispatching via `Agent()`, pass `model="sonnet"` or `model="opus"` explicitly.

| Complexity | Model | Examples |
|---|---|---|
| Simple mechanical (1-2 files, clear spec) | **Sonnet** | Renames, adding a field by existing pattern, cosmetics, docs, template code |
| Integration / judgment (multi-file, pattern matching, debugging) | **Sonnet** default, **Opus** when uncertain | New API endpoint following an existing template, refactoring one composable |
| Architecture, cross-domain review, critical logic | **Opus** | New ADRs, complex Tauri backend changes, sync/Dolt engine, hard production bug diagnosis, code review of critical code |

Agent frontmatter already specifies `model: sonnet` for most agents; the orchestrator (Opus) may implicitly inherit — set `model="sonnet"` explicitly for simple tasks to avoid burning Opus on trivialities.

### Completion Report Vocabulary

Supervisors return one of four statuses (full definitions live in each supervisor file):

- **DONE** — work complete, no doubts. Orchestrator → code review.
- **DONE_WITH_CONCERNS** — complete but with caveats. Orchestrator reads concerns; if about correctness/scope → fix before review; if observations → note and proceed.
- **BLOCKED** — supervisor cannot finish. Orchestrator diagnoses: missing context (add, re-dispatch) / needs more reasoning (re-dispatch with more powerful model) / task too big (split) / plan wrong (escalate to user).
- **NEEDS_CONTEXT** — missing info. Orchestrator supplies and re-dispatches.

**Never** re-dispatch the same model on BLOCKED without changing something. If a supervisor is stuck — something must change.

## GitHub — Account: Maxpceo

### Releases
1. **Update `CHANGELOG.md`** with the target version heading and all changes
2. **Run `./release.sh`** — interactive script that:
   - Checks branch (must be main), tests, TypeScript
   - Asks for new version number with confirmation
   - Verifies CHANGELOG has an entry for the version
   - Updates version in `package.json` + `src-tauri/tauri.conf.json`
   - Creates commit, tag, pushes — with confirmation at each step
   - GitHub Actions automatically builds DMG/EXE/AppImage from the tag
3. **Update `.claude/codebase-map.md`** to reflect any structural changes (new files, composables, commands, etc.)

**Release notes must include:**
- bd compatibility: `> Works with **bd 0.49+** (tested on 0.63.3 and 1.0.x). Self-managing Dolt server on 0.57+.`
- **Never upload DMG manually** — GitHub Actions handles artifacts
- macOS unsigned certificate notice:
  ```
  xattr -cr /Applications/Beads\ Task-Issue\ Tracker.app
  ```

### Commits
- **Always in English** — open source standard for international contributors
- Conventional Commits format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `release:`
- Keep `Co-Authored-By: Claude Code <noreply@anthropic.com>` for transparency

## Permissions

### Always Allowed (no confirmation needed)
- All `bd` CLI commands
- File operations on `.claude/` and `.beads/`
- `~/.claude/` (global config)

### Always Require Confirmation
- `git commit`, `git push`, `/close-issue`

## Plan Mode

Save plans in `.claude/plans/` (local to project), never `~/.claude/plans/`.

### Save approved plan

If a task went through Plan Mode and got approval — save the approved plan as an artifact before dispatching any supervisor:

- Preferred: `.claude/plans/{bead-id}.md` with the plan body
- Alternative: `bd update {ID} --design "PLAN (approved YYYY-MM-DD): ..."`

Format:
```
PLAN (approved YYYY-MM-DD)
Problem: <1-2 sentences>
Approach: <what we do>
Rejected alternatives: <what we considered and why we declined — protects against drift on re-dispatch>
Files to change: <paths>
Acceptance: <how we will verify>
```

**Why:** the plan survives the session. On `NOT APPROVED` and re-dispatch the supervisor sees the original plan. The reviewer cross-checks it during Phase 1 spec compliance. Rejected alternatives are recorded — nobody can "forget" and do it differently.

**Skip** for small fixes that didn't use Plan Mode.
