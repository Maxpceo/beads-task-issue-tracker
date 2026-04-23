---
name: pre-dispatch
description: "Подготовка к dispatch supervisor'а — claim bead, собрать START_COMMIT и BRANCH, сгенерировать шаблон промпта. Используй этот скилл ПРОАКТИВНО когда пользователь говорит: запусти задачу, dispatch bead, начни работу над задачей, диспатчить, отправь supervisor, запусти supervisor, возьми bead в работу, начни bead, claim задачу. Также когда пользователь указывает конкретный bead ID и просит начать над ним работу."
---

# Pre-Dispatch — Подготовка к dispatch supervisor'а

> **Execution style** — см. `CLAUDE.md § Workflow Execution Style` (без промежуточных вопросов включая переходы между skill'ами + табличный итоговый отчёт).

Подготовь всё необходимое для dispatch supervisor'а.

## Определить bead

Если пользователь указал bead ID — используй его.

Если не указал — покажи список ready beads:
```bash
bd ready
```
И спроси, какой bead dispatch'ить.

## Шаг 1: Проверить bead

```bash
bd show {BEAD_ID}
```

Убедись что:
- Bead существует
- Статус `open` — можно dispatch'ить
- Если `in_progress` — предупреди: "Этот bead уже в работе. Продолжить?"
- Если `closed`/`done`/`inreview` — СТОП, нельзя dispatch'ить

## Шаг 2: Прочитать контекст

```bash
bd comments {BEAD_ID}
```

Покажи пользователю краткое содержание bead + комментарии (если есть).

## Шаг 3: Claim bead

```bash
bd update {BEAD_ID} --claim
```

`--claim` — атомарный: assignee + status=in_progress в одну операцию. Используй вместо `--status in_progress` — это исключает race с параллельной сессией.

## Шаг 4: Собрать информацию для dispatch

```bash
git rev-parse HEAD
git branch --show-current
```

## Шаг 5: Определить тип supervisor'а

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

## Шаг 6: Показать готовый шаблон промпта

Выведи готовый к использованию dispatch:

```
Task(
  subagent_type="{supervisor-type}",
  prompt="BEAD_ID: {BEAD_ID}
BRANCH: {текущая ветка}
START_COMMIT: {текущий HEAD hash}

{Описание задачи из bead}"
)
```

## Шаг 7: Напомнить про code review

Скажи: "После завершения supervisor'а не забудь code review:
```
Task(
  subagent_type="code-reviewer",
  prompt="BEAD_ID: {BEAD_ID}\nBRANCH: {ветка}\nSTART_COMMIT: {commit}\n\nReview git diff {commit}..HEAD"
)
```"
