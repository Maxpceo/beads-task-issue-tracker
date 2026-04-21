---
name: merge-to-main
description: "Full merge cycle: feature branch → auto-land (commit + push) → PR → update docs → merge → checkout main. Use PROACTIVELY when user says: make a PR, let's merge, merge to main, pull request, we're done with this branch, push to main, let's finish this feature, давай мержить, сделай PR, мержим в мастер, пора мержить, переходим в main, создай PR, влей в main, заканчиваем с этой веткой. Запускать `/land` перед этим skill'ом НЕ нужно — Step 0.5 сам подтягивает незакоммиченные файлы и пушит ветку. Поддерживает флаг пропуска документации: «без документации», «без доки», «no-docs», «skip-docs», «skip docs», «пропусти документацию». НЕ путай с `land`: `land` = только commit + push в feature-ветку внутри сессии; `merge-to-main` = полный цикл до main."
---

# Merge to Master — Full PR + Docs + Merge Cycle

Automated workflow for merging a feature branch into main.

**ВАЖНО:** Запускать `/land` перед этим skill'ом НЕ нужно. Step 0.5 сам обнаруживает dirty tree / ahead-of-remote и делегирует `land`, чтобы код был закоммичен и запушен до создания PR.

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
   # Пример: после того как собрал список новых symbol names из diff
   grep -rn "symbolA\|symbolB" docs/ README.md
   ```
   Нет совпадений → **auto-skip Step 3**, в Step 7 отчёте отметить: «Документация: auto-skip (diff: только tests/config, docs/README.md не упоминает изменённых символов)».
5. Если критерий (2) или (3) не выполнен, или Grep нашёл упоминания → dispatch `documentation-expert` как обычно.

Это **не дублирует** явный флаг пользователя — это ветка для «пользователь не сказал, но diff явно тривиальный». Orchestrator делает только triage (`git diff` + `grep`), не генерирует docs; dispatch остаётся для нетривиальных изменений.

## Current state

!`git status --short && echo "===" && git branch --show-current && echo "===" && git log --oneline main..HEAD 2>/dev/null | head -20`

## Step 0: Pre-flight bead check (auto-land)

Цель: убрать ручную двухфазность «сначала `/land`, потом merge». Skill сам обнаруживает незакрытые beads текущей фичи и предлагает закрыть через `AskUserQuestion`.

```bash
echo "=== in_progress ===" && bd list --status=in_progress --assignee="$(git config user.name)" 2>&1 | head -20
echo "=== inreview ===" && bd list --status=inreview --assignee="$(git config user.name)" 2>&1 | head -20
```

Логика:

1. Извлечь bead-ID текущей фичи из `git log main..HEAD` + branch name (regex: `beads-task-issue-tracker-[a-z0-9]{4}`).
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

## Step 0.5: Auto-land (commit + push если нужно)

Цель: не дать `gh pr create` упасть на «no commits between» или на dirty working tree. Skill сам подтягивает локальное состояние ветки до origin.

```bash
git status --short
git rev-list --count "@{u}..HEAD" 2>/dev/null || echo "no upstream"
```

Разветвление:

| Ситуация | Действие |
|---|---|
| Clean working tree И 0 коммитов ahead | Ничего не делаем, переходим к Step 1 |
| Dirty working tree (есть изменения в отслеживаемых файлах) ИЛИ >0 коммитов ahead | Делегировать skill `land` — он сделает commit (если нужно) + `bd merge-slot acquire` + `git pull --rebase && git push`, освободит слот. После возврата `land` → Step 1. |
| Upstream не настроен (ветка никогда не пушилась) | Делегировать `land` — он сам сделает `git push -u origin <branch>` |
| Untracked файлы, НЕ относящиеся к фиче (например, случайные артефакты) | Показать список пользователю, спросить через `AskUserQuestion`: «Add to commit / Leave alone / Abort» |

Skill `land` уже обрабатывает merge-slot contention, `git pull --rebase` race, и безусловный release слота при любой ошибке. Не дублируй эту логику — просто делегируй.

**Skip-триггер:** фразы «skip land», «не пуши», «без push» — переходим к Step 1, и если `gh pr create` потом упадёт — показываем ошибку пользователю, он сам решит.

## Step 1: Pre-flight Checks

```bash
git status --short
git branch --show-current
git log --oneline main..HEAD
```

Verify:
- Current branch is NOT main (if on main → STOP, tell user "Already on main")
- После Step 0.5: working tree clean и ветка в синхроне с origin (если нет — Step 0.5 не отработал, STOP и разобраться)

Run quality gates:
```bash
pnpm test && npx vue-tsc --noEmit
```

If tests fail → STOP, fix before merging.

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

Show PR URL to user.

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

Следуй инструкциям в `.claude/agents/documentation-expert.md` при их наличии.

После обновления — commit локально (push сделает orchestrator в Step 5).

## ОБЯЗАТЕЛЬНЫЙ финальный блок

В КОНЦЕ ответа (даже при обрыве / таймауте — постарайся довести до этого блока):

### DOCS REPORT

- Status: UPDATED | NOTHING_TO_UPDATE | PARTIAL | ERROR
- Commit SHA: <sha> или —
- Таблица изменений (обязательно, даже если один файл):

| Файл | Что изменилось |
|---|---|
| path/to/file.md | краткое описание правки (1 строка) |

"""
)
```

### После возврата агента — orchestrator ВСЕГДА печатает factual-отчёт таблицей

Не доверяй словам агента (он мог оборваться по timeout). Бери факты из git и покажи пользователю **Markdown-таблицу** (не list, не сырой `git show --stat`):

```bash
DOCS_SHA=$(git log -1 --format=%H)
DOCS_SUBJ=$(git log -1 --format=%s)
git show --name-only --format="" "$DOCS_SHA"
```

Шаблон итогового отчёта пользователю:

```markdown
## 📋 Документация обновлена

**Commit:** `<SHORT_SHA>` — _<subject>_

| Файл | Что изменилось |
|---|---|
| `path/to/file1.md` | краткое описание (1 строка) |
| `path/to/file2.md` | … |
```

Правила заполнения колонки «Что изменилось»:
1. Сначала — описания из `DOCS REPORT` агента, если он вернул таблицу.
2. Если агент не вернул описания — сгенерируй сам по `git diff <sha>^..<sha> -- <file>` (1 короткая строка на файл, суть правки).
3. НЕ выводи сырой `git show --stat` — пользователь явно просил таблицу, не список со строками `+/−`.

Если `docs:`-коммита нет (агент ничего не правил / оборвался до commit) — вывести короткую сводку «Документация: без изменений» + `git status --short` для диагностики.

## Step 4: Wait for CI

After the docs-expert agent pushes its commit, CI runs again on the latest branch state. We must NOT merge until all checks pass — otherwise we merge broken code into main.

Capture the PR number (from Step 2 `gh pr create` output — it returns a URL ending in `/pull/<N>`), then block on GitHub Actions:

```bash
gh pr checks <PR_NUMBER> --watch --fail-fast
```

Behavior:
- `--watch` — blocks until all checks complete (can take several minutes — that's fine, just wait).
- `--fail-fast` — exits immediately with non-zero as soon as any check fails.
- Exit 0 → all required checks passed → proceed to Step 5.
- Exit non-zero → a check failed or was cancelled. **STOP.** Do NOT merge. Report to the user:
  - Which check failed (from the command output)
  - The PR URL so they can inspect logs
  - Do not retry blindly — the user must investigate and fix the failure on the branch. Typically: pull latest, reproduce the failure locally (`pnpm test` / `npx vue-tsc --noEmit` / `cargo check`), fix, commit, push, and re-run the skill from Step 4.

**Important:** If the PR has no CI configured (`gh pr checks` reports "no checks reported"), treat that as a warning and ask the user whether to proceed. Do NOT silently skip.

## Step 5: Merge PR (через merge-slot)

Захватить `bd merge-slot` ПЕРЕД `gh pr merge` — гарантирует, что merge + последующий `git pull origin main` (Step 6) атомарны относительно других параллельных сессий, которые тоже могут мёрджить свои PR. Слот удерживается ~10–30 секунд.

**Важно: если `bd merge-slot acquire` упал (non-zero exit, сообщение `Slot held by X` или любая другая ошибка) — STOP, НЕ вызывай `gh pr merge`.** Merge-slot advisory — `gh pr merge` не знает про него и смёржит PR, игнорируя замок, что создаёт гонку с параллельной сессией (non-fast-forward, потерянный push, конфликт в pull). Если acquire failed — покажи пользователю кто держит слот (`bd show beads-task-issue-tracker-merge-slot`) и спроси: ждать (повторить acquire после release), встать в очередь (`bd merge-slot acquire --wait`), или отменить merge. Не форсируй без явного согласия.

```bash
if ! bd merge-slot acquire; then
  bd show beads-task-issue-tracker-merge-slot
  # STOP. Спросить пользователя, не запускать gh pr merge.
fi

gh pr merge <PR_NUMBER> --merge --delete-branch
```

**При любом исходе — release слота:** если `gh pr merge` упал (конфликты, permission denied, branch out-of-date, и т.д.) — ОБЯЗАТЕЛЬНО выполнить `bd merge-slot release` ДО того как репортить пользователю. Слот, который не освободили, заблокирует все остальные сессии до ручного release.

```bash
# на любой ошибке merge:
bd merge-slot release
# затем сообщить пользователю об ошибке и помочь разрешить
```

## Step 6: Switch to main + release слота

```bash
git checkout main && git pull origin main

# Освободить merge-slot — следующая параллельная сессия может мёрджить.
bd merge-slot release
```

## Step 7: Report

Show user:
- PR URL (link)
- What documentation was updated
- Confirmation: "On main branch, everything up to date"
- Reminder: "To release a version, run ./release.sh"
