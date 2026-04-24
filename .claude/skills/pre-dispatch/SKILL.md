---
name: pre-dispatch
description: "Inline Task dispatch supervisor'а после approved плана — собрать BRANCH/START_COMMIT, выбрать тип supervisor'а, немедленно вызвать Task(...). Используй этот скилл ПРОАКТИВНО когда пользователь говорит: запусти задачу, dispatch bead, диспатчить, отправь supervisor, запусти supervisor, начни работу над задачей (с конкретным bead ID). Запускается orchestrator'ом автоматически после ExitPlanMode approved — не требует отдельной фразы пользователя. Для фраз без ID («возьми», «claim», «начни bead») — см. claiming-bead."
---

# Pre-Dispatch — Inline Task dispatch после approved плана

> **Execution style** — см. `CLAUDE.md § Workflow Execution Style` (без промежуточных вопросов включая переходы между skill'ами + табличный итоговый отчёт).

Этот skill запускается **после** `claiming-bead` и approved плана — bead уже claimed, контекст прочитан. Не повторяй `bd show` / `bd comments` / `bd update --claim`.

Единственная ответственность: собрать `BRANCH`/`START_COMMIT`, выбрать тип supervisor'а, **немедленно** вызвать `Task(...)` inline в том же message turn.

## Guard (обязательный, read-only)

Перед сбором метаданных убедись, что bead действительно claimed:

```bash
bd show {BEAD_ID} | head -3
```

- Если статус **не** `in_progress` или assignee **не** me → СТОП. Не dispatch'и на незаклеймленный bead. Сообщи пользователю: «bead не claimed — запусти `claiming-bead` сначала (фраза "возьми {ID}")».
- Guard покрывает сценарии: retry после `BLOCKED` supervisor'а, worktree без предварительного claiming-bead, прямой триггер pre-dispatch вне цепочки.
- `bd show` — read-only, допустим даже в Plan Mode.

## Step 1: Собрать информацию для dispatch

```bash
git rev-parse HEAD
git branch --show-current
```

## Step 2: Определить тип supervisor'а

Эвристика (в порядке приоритета):

1. **По labels** (из CLAUDE.md таблицы):
   - `frontend` / `ui` / `data` / `sync` (TS-часть) → `vue-supervisor`
   - `backend` / `tracker` → `tauri-supervisor`
   - `sync` (Rust-часть в `src-tauri/sync/`) → `tauri-supervisor`
   - `ci` / `dx` → `test-supervisor`

2. **По description** — упоминание:
   - Vue / component / page / composable → `vue-supervisor`
   - Rust / Tauri / command / Cargo → `tauri-supervisor`
   - test / vitest / spec → `test-supervisor`

3. **По staged/planned файлам**:
   - `.vue` / `app/composables/` / `app/pages/` → `vue-supervisor`
   - `.rs` / `src-tauri/` → `tauri-supervisor`
   - `.test.ts` / `tests/` → `test-supervisor`

4. **Неоднозначно** (многодоменный bead) → `AskUserQuestion`.

## Step 3: Запусти Task inline (без промежуточного вопроса)

Вызови `Task(subagent_type=..., prompt=...)` **в том же message turn**, что и финальный отчёт pre-dispatch. Не выводи шаблон как текст пользователю — tool call виден в транскрипте сам по себе.

Формат prompt'а — см. `.claude/references/workflow-templates.md §3 Dispatch Prompt Skeleton`.

**Запрещено:**
- «Сказать "поехали" — запущу…»
- «Готов dispatch'ить, подтвердите»
- Любой текстовый preview Task-вызова перед самим tool call'ом

Approved план = approved dispatch. Переход входит в список «не требуют вопроса» (`CLAUDE.md § Workflow Execution Style § 1`).

## Итоговый отчёт

Таблица `| Шаг | Результат |` в том же message turn, что и Task tool call (per `CLAUDE.md § Workflow Execution Style § 2`):

```
| Шаг          | Результат                        |
|--------------|----------------------------------|
| Guard        | bead in_progress, assignee=me    |
| BRANCH       | fix/bd-77t                       |
| START_COMMIT | 5fcfce4                          |
| Supervisor   | vue-supervisor (label=frontend)  |
| Task dispatch| launched inline                  |
```
