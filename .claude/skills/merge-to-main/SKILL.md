---
name: merge-to-main
description: "Full merge cycle: feature branch → commit + push → PR → update docs → merge → checkout main. Use PROACTIVELY when user says: make a PR, let's merge, merge to main, pull request, we're done with this branch, push to main, let's finish this feature, давай мержить, сделай PR, мержим в мастер, пора мержить, переходим в main, создай PR, влей в main, заканчиваем с этой веткой. Запускать `/land` перед этим skill'ом НЕ нужно — Step 1 сам коммитит незакоммиченные файлы и пушит ветку. Поддерживает флаг пропуска документации: «без документации», «без доки», «no-docs», «skip-docs», «skip docs», «пропусти документацию». НЕ путай с `land`: `land` = только commit + push в feature-ветку внутри сессии; `merge-to-main` = полный цикл до main."
---

# Merge to Main — Full PR + Docs + Merge Cycle

> **Execution style** — см. `CLAUDE.md § Workflow Execution Style` (без промежуточных вопросов включая переходы между skill'ами + табличный итоговый отчёт).

Automated workflow for merging a feature branch into main.

## Флаг: пропуск документации

Если в запросе пользователя есть одна из фраз: **«без документации», «без доки», «no-docs», «skip-docs», «пропусти документацию», «skip docs»** — **пропусти Step 3 целиком**, перейди со Step 2 сразу к Step 4. В итоговом отчёте (Step 7) отметь: «Документация: пропущена по запросу».

**Когда пропуск уместен:**
- Внутренний рефакторинг / cleanup без новых публичных API.
- Правки конфигов, хуков, CI, скриптов.
- Баг-фикс без изменения контрактов.
- Изменения < 20 строк в одном файле.

**Когда уточнить у пользователя (даже если флаг есть):**
- Новая фича с UI- или API-изменениями, видимыми пользователю.
- Изменение существующих контрактов команд Tauri, composable'ов, стор'ов.
- Новые public экспорты из `app/utils/`, `app/composables/`.
- Изменение схемы данных, миграция.

Если флага нет — сначала прогоняй auto-detect ниже.

### Auto-detect (без явного флага)

Если пользователь не указал skip-фразу, orchestrator делает быструю проверку **перед** dispatch documentation-expert:

1. `git diff --name-only main..HEAD` — список изменённых файлов.
2. Все ли файлы попадают в «tests / config / docs-meta / tooling»?
   - `tests/**`, `**/*.test.*`, `**/*.spec.*`
   - `.beads/**`, `.claude/**`
   - `*.md`, `*.yaml`, `*.yml`, `*.toml`, `*.json`
   - `scripts/**`, `.github/**`
3. Если среди изменённых есть `.vue`/`.ts`/`.rs` — проверить что нет новых публичных API:
   ```bash
   git diff -G '^(export |function |class |fn |pub fn |#\[tauri::command\])' main..HEAD | wc -l
   ```
   Ожидается `0` (нет новых `export`/`function`/`class`/Rust `fn`/`pub fn`/`#[tauri::command]`).
4. Если (2) и (3) выполнены → один `Grep` изменённых ключевых символов в `docs/` + `README.md`:
   ```bash
   grep -rn "symbolA\|symbolB" docs/ README.md
   ```
   Нет совпадений → **auto-skip Step 3**, в Step 7 отчёте отметить: «Документация: auto-skip».
5. Если критерий (2) или (3) не выполнен, или Grep нашёл упоминания → dispatch `documentation-expert` как обычно.

## Current state

!`git status --short && echo "===" && git branch --show-current && echo "===" && git log --oneline main..HEAD 2>/dev/null | head -20`

## Step 0: Pre-flight bead check

```bash
echo "=== in_progress ===" && bd list --status=in_progress --assignee="$(git config user.name)" 2>&1 | head -20
echo "=== inreview ===" && bd list --status=inreview --assignee="$(git config user.name)" 2>&1 | head -20
```

Логика:

1. Извлечь bead-ID текущей фичи из `git log main..HEAD` + branch name (regex: `beads-task-issue-tracker-[a-z0-9]{3}`).
2. Разделить списки `in_progress`/`inreview` на **feature-related** (ID из шага 1) и **background** (ID не связанные с текущей веткой).
3. Разветвление:

   | Ситуация | Действие |
   |----------|----------|
   | Оба списка пусты | Тихо переходим к Step 1 |
   | Feature-beads открыты | `AskUserQuestion`: «Close these beads before merge?» → `Close now` / `Leave open` |
   | Пользователь выбрал `Close now` | Делегировать `reviewing-code` (для статуса `inreview`) ИЛИ `bd close` (для `in_progress`), затем возобновить Step 1 |
   | Пользователь выбрал `Leave open` | Перейти к Step 1 (beads останутся открытыми) |
   | Только background beads | Перечислить их как «background tasks (другие сессии)», перейти к Step 1 без вопросов |
   | Пользователь явно сказал «skip bead check» | Перейти к Step 1 |

Skip-триггер: если в сообщении пользователя есть фразы «skip bead check», «без проверки beads», «merge as-is» — пропустить Step 0 целиком.

## Step 1: Pre-flight — commit, push, quality gates

```bash
git status --short && echo "===" && git branch --show-current && echo "===" && git log --oneline main..HEAD
```

**Если ветка — `main`:** СТОП, сообщи «Already on main».

### 1a. Untracked файлы

Если есть untracked файлы, не относящиеся к фиче (случайные артефакты) — показать список пользователю, спросить через `AskUserQuestion`: «Add to commit / Leave alone / Abort».

### 1b. Commit если нужно

Если есть незакоммиченные изменения в отслеживаемых файлах:

```bash
git add <изменённые файлы> && git commit -m "$(cat <<'EOF'
<краткое описание изменений>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Сгенерируй сообщение коммита на основе `git diff --cached` (Conventional Commits, English).

Затем проверь и закоммить `.beads/` отдельно (статус bead мог измениться в Step 0):

```bash
git add .beads/ && git diff --cached --quiet || git commit -m "sync beads"
```

### 1c. Quality gates

```bash
pnpm test && npx vue-tsc --noEmit
```

Если тесты упали → СТОП, исправь перед merge.

### 1d. Push если нужно

Если есть коммиты впереди origin или upstream не настроен:

```bash
if ! bd merge-slot acquire; then
  bd show beads-task-issue-tracker-merge-slot
  # СТОП — спросить пользователя (ждать / --wait / отменить)
fi

git pull --rebase && git push -u origin "$(git branch --show-current)" && echo "===PUSHED==="
bd merge-slot release
```

На любой ошибке push — **обязательно** `bd merge-slot release` перед тем как сообщать пользователю.

## Step 2: Create Pull Request

Compose PR title and body from `git log main..HEAD`:
- Title: concise summary (< 70 chars, English)
- Body: summary + key changes list

```bash
gh pr create --base main --title "..." --body "$(cat <<'EOF'
## Summary
- bullet points

## Changes
[key changes from git log]
EOF
)"
```

Запомни номер PR из URL (`/pull/<N>`). Покажи URL пользователю.

## Step 3: Update Documentation

Пропусти целиком, если сработал skip-флаг или auto-detect выше.

Dispatch the documentation-expert agent:

```
Agent(
  subagent_type="documentation-expert",
  prompt="""Обнови документацию проекта, учитывая изменения в текущей ветке.

Branch: <current branch name>
Commits: <output of git log main..HEAD --oneline>

Проверь и обнови:
- CHANGELOG.md под `[Unreleased]` (если code-изменения user-facing).
- README.md (если затронуты видимые пользователю фичи/команды/установка).
- Любые релевантные файлы в `docs/` (если затронуты описанные там подсистемы).

После обновления — commit локально (push сделает orchestrator).

## ОБЯЗАТЕЛЬНЫЙ финальный блок

### DOCS REPORT

- Status: UPDATED | NOTHING_TO_UPDATE | PARTIAL | ERROR
- Commit SHA: <sha> или —
- Таблица изменений:

| Файл | Что изменилось |
|---|---|
| path/to/file.md | краткое описание правки (1 строка) |

"""
)
```

### После возврата агента — orchestrator печатает factual-отчёт таблицей

```bash
DOCS_SHA=$(git log -1 --format=%H)
git show --name-only --format="" "$DOCS_SHA"
```

Шаблон:

```markdown
## Документация обновлена

**Commit:** `<SHORT_SHA>` — _<subject>_

| Файл | Что изменилось |
|---|---|
| `path/to/file.md` | краткое описание (1 строка) |
```

Если `docs:`-коммита нет — вывести «Документация: без изменений» + `git status --short`.

Не выводи сырой `git show --stat` — только таблицу.

## Step 4: Wait for CI

```bash
gh pr checks <PR_NUMBER> --watch --fail-fast
```

- Exit 0 → переходим к Step 5.
- Exit non-zero → СТОП, не мёрджим. Показать пользователю какой check упал + PR URL.
- Если CI не настроен (`no checks reported`) → спросить пользователя через `AskUserQuestion`, продолжать ли без CI.

## Step 5: Merge PR (через merge-slot)

**Важно: если `bd merge-slot acquire` упал — СТОП, НЕ вызывай `gh pr merge`.** Показать кто держит слот и спросить пользователя.

```bash
if ! bd merge-slot acquire; then
  bd show beads-task-issue-tracker-merge-slot
  # СТОП. Спросить пользователя, не запускать gh pr merge.
fi

gh pr merge <PR_NUMBER> --merge --delete-branch
```

На любой ошибке merge — **обязательно** `bd merge-slot release` перед отчётом пользователю.

## Step 6: Switch to main + release слота

```bash
git checkout main && git pull origin main
bd merge-slot release
```

**На любой ошибке в Step 6** (например, `git checkout main` упал) — **обязательно** `bd merge-slot release` перед отчётом пользователю. Слот был захвачен в Step 5 и должен быть освобождён в любом исходе.

## Step 7: Report

| Шаг | Результат |
|-----|-----------|
| Commit | `<sha>` или «не требовался» |
| Push | OK / «не требовался» |
| PR | [#N](url) |
| Документация | обновлена / auto-skip / пропущена по запросу |
| CI | PASS / SKIP (нет конфига) |
| Merge | OK |
| Branch | main, `<sha>` |
| Follow-up beads | `<count>` / — |

**Follow-up beads** — сюда идут bead'ы, созданные через `bd create` в течение этой сессии (pre-existing findings из RAMS/WIG/detective review, edge-cases, проблемы вне scope). Ведёшь ментальный учёт по ходу сессии: каждый раз, когда сам вызвал `bd create` или supervisor вернул новый ID, запомни.

Если таких не было — прочерк в ячейке, секции ниже не печатай.

Если были — **обязательно** после основной таблицы добавь:

```markdown
## Bead'ы, созданные в этой сессии

| Bead | Статус | Что |
|------|--------|-----|
| `beads-task-issue-tracker-<id>` | open / closed | краткая суть, 1 строка |
```

Включай и уже закрытые в этой же сессии (например, ты вынес follow-up в `bd-xxx`, а потом сразу взял и закрыл его — он всё равно идёт в таблицу со статусом `closed`).

Если сомневаешься, не упустил ли что-то — fallback-проверка:

```bash
bd list --status=open,closed --json | jq -r --arg ts "<session-start-ISO>" '.[] | select(.created >= $ts) | "\(.id)\t\(.status)\t\(.title)"'
```

Reminder: «To release a version, run ./release.sh»

## Step 8: Финальный вердикт «можно ли закрывать сессию»

**Цель:** одна строка в самом конце ответа, по которой пользователь без вчитывания в таблицу решает — закрывать ли сессию. Эта строка ВСЕГДА последняя в ответе после Step 7 (после Reminder про `./release.sh`).

### Чек-лист (orchestrator выполняет проверки **сам** через Bash, не делегирует)

```bash
echo "=== branch ==="; git branch --show-current
echo "=== dirty ==="; git status --short
echo "=== ahead/behind ==="; git rev-list --left-right --count origin/main...HEAD
echo "=== local feature branches ==="; git branch --list 'fix/*' 'feat/*' 'chore/*' 'refactor/*' 'docs/*'
echo "=== worktrees ==="; git worktree list
echo "=== beads ==="; bd list --status=in_progress,inreview --assignee="$(git config user.name)" 2>&1 | head -10
echo "=== merge-slot ==="; bd show beads-task-issue-tracker-merge-slot 2>&1 | grep -E "Status|holder"
```

### Условия чистоты (все должны выполниться):

1. Текущая ветка — `main`.
2. Working tree чистый (`git status --short` пуст).
3. `main` не отстаёт от `origin/main` (`ahead/behind` = `0	0`).
4. Нет локальных feature-веток (`fix/*`, `feat/*`, `chore/*`, `refactor/*`, `docs/*`) — только `main`.
5. Нет лишних worktree'ев кроме основного репо.
6. Нет beads в `in_progress` / `inreview` на текущего юзера.
7. Merge-slot не держим (`Status: open` или holder ≠ текущий юзер).

### Финальная строка (печатать буквально, одна из двух):

**Если всё чисто:**

```markdown
---

✅ **Сессию можно закрывать** — main чистый, ничего не висит.
```

**Если что-то не чисто** — перечислить в одну строку **только** причины, которые не выполнены, без пустых:

```markdown
---

⚠️ **Сессию НЕ закрывать**: <причина1>; <причина2>; ...
```

Примеры причин (формулировать конкретно — с ID/именами/количеством):
- `остался worktree fix/bd-xxx`
- `локальные ветки: feat/bd-yyy, chore/zzz`
- `bead beads-task-issue-tracker-aaa в in_progress`
- `working tree dirty (3 файла)`
- `main отстаёт от origin (behind 2)`
- `держим merge-slot (надо bd merge-slot release)`
- `не на main (текущая: fix/bd-bbb)`

### Правила формата:

- Финальная строка — **последняя** в ответе. После неё — ничего (даже пустой строки).
- Перед строкой — горизонтальный разделитель `---` для визуального якоря.
- Эмодзи `✅` / `⚠️` обязательны — глаз цепляется быстрее.
- Если хоть одно условие не выполнено — это ⚠️, не ✅. Не «частично чисто».
- Не дублируй причины из основной таблицы Step 7. Только то, что мешает закрыть сессию **сейчас**.
