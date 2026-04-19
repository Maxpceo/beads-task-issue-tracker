# bd — база знаний по внутреннему устройству

Справочник по семантике bd: где хранятся определения, где использования, какие категории у статусов, что куда спрашивать. Файл **не автозагружается** — читай явно при вопросах про bd, или сверяйся, когда что-то в поведении bd кажется неочевидным.

Первая партия инсайтов собрана в ходе работы над бидом `beads-task-issue-tracker-ud2`. Новые инсайты добавлять следующими пунктами в подходящий раздел; если разрастётся — разбить на sub-references (`bd-categories.md`, `bd-storage.md`) и оставить этот файл как index.

---

## 1. Источники правды для статусов

### Команды CLI

- **`bd statuses`** — человекочитаемый список built-in + custom с иконками и категориями. Это **канонический** источник списка.
- **`bd statuses --json`** — то же самое в JSON. Именно эту форму дёргает Tauri-бэкенд.
- **`bd config get status.custom`** — сырой config-ключ в формате `name:category,name:category,...`. Храниться в Dolt-базе проекта (а не в `config.yaml` — см. раздел 4).
- **`bd config --help`** → «Custom Status States» — официальная документация формата.

### Внутри приложения

- Rust-бэкенд (`src-tauri/src/tracker/`) исполняет `bd statuses --json` и отдаёт через Tauri-команду **`bd_statuses`**.
- Фронт подписан через композабл `app/composables/useStatuses.ts:58` → `invoke<BdStatusesResponse>('bd_statuses', { options: { cwd: path } })`.

### ❌ Антипаттерн

Читать `.beads/issues.jsonl` чтобы узнать **какие статусы есть**. В этом файле лежат только значения `status` у реальных задач — то есть **используемые**, не определённые. Custom-статус может быть определён в конфиге, но ни одна задача его не использует — в JSONL его не будет. Проверено на `invest_fund_sharks` (конфиг содержит `inreview/simplified/reviewed/accepted`, а в JSONL — только `open/in_progress/deferred/closed`).

---

## 2. Категории bd-статусов (authoritative)

Категория — опциональная аннотация к статусу, определяет поведение в `bd ready`/`bd list`. Возможные значения и семантика (`bd statuses --help`):

| Категория | В `bd ready` | В дефолтном `bd list` | Семантика |
|-----------|:------------:|:---------------------:|-----------|
| `active`  | да           | да                    | Доступно к работе |
| `wip`     | нет          | да                    | Работа в процессе |
| `frozen`  | нет          | нет                   | Отложено / на паузе |
| `done`    | нет          | нет                   | Terminal |
| `(none)`  | нет          | да                    | Legacy-формат без категории |

### Built-in статусы bd 1.x и их реальные категории

| Статус        | Категория | Counter-intuitive? |
|---------------|-----------|:------------------:|
| `open`        | active    | — |
| `in_progress` | wip       | — |
| `blocked`     | **wip**   | ✓ (не `frozen`) |
| `deferred`    | frozen    | — |
| `closed`      | done      | — |
| `pinned`      | **frozen**| ✓ (не `active`) |
| `hooked`      | **wip**   | ✓ (не `active`) |

**Вывод:** интуиция обманывает на `blocked/pinned/hooked`. Всегда сверять с `bd statuses --json`, а не писать «из головы». Тест-guard живёт в `tests/composables/useStatuses.test.ts` — ломает build при рассинхронизации с `BUILTIN_FALLBACK`.

---

## 3. Кастомные статусы

### Формат

```bash
bd config set status.custom "name1:category1,name2:category2,..."
```

- Категория **опциональна**: `bd config set status.custom "awaiting_review"` → без категории → legacy, не в `bd ready`, но в `bd list`.
- Категории — только из списка раздела 2 (`active`/`wip`/`frozen`/`done`).
- Удаление: `bd config unset status.custom` или `bd config set status.custom ""`.

### В проектах Максима

В `beads-task-issue-tracker` и `invest_fund_sharks` определены (review chain):

| Статус       | Категория |
|--------------|-----------|
| `inreview`   | wip       |
| `simplified` | wip       |
| `reviewed`   | wip       |
| `accepted`   | wip       |

### Определения ≠ использования

Custom-статус может быть определён в конфиге, но ни одна задача его **сейчас** не использует (пример: `invest_fund_sharks` в момент UD2 — 4 custom определены, 0 задач в них). Это нормально: custom-статус — это возможность, не обязательство. Пустой `bd list --status=inreview` не означает, что статус не валиден.

---

## 4. Где хранятся определения vs использования

| Артефакт | Что там | Кто пишет | Кто читает |
|----------|---------|-----------|------------|
| **Dolt-база** (`.beads/dolt/` source + `.beads/ephemeral.sqlite3` зеркало) | Определения (`status.custom` config, built-ins, типы, labels) + использования (все issue-состояния) | `bd` при любом write | `bd` на любой query |
| **`.beads/issues.jsonl`** | Дамп задач (status/priority/labels/deps/comments) | `bd` auto-export (throttled, default 60s) | git-sync между машинами, viewers (bv), **read-only** для консюмеров |
| **`.beads/config.yaml`** | Только auto-export settings (`export.auto`, `export.path`, `export.interval`, `export.git-add`) | Пользователь через `bd config set export.*` | `bd` для решения, куда писать JSONL |

### Важные следствия

- **Custom-статусы живут в Dolt**, не в `config.yaml`. `config.yaml` — это только про auto-export.
- **JSONL сам по себе не self-sufficient источник истины**: импорт его в пустую базу восстанавливает задачи, но не custom status definitions — они едут через Dolt push/pull.
- **Auto-export keys** (`bd config set export.<key>`):
  - `export.auto` (default `true`) — включён/выключен
  - `export.path` (default `issues.jsonl`) — имя файла в `.beads/`
  - `export.interval` (default `60s`) — минимум между экспортами
  - `export.git-add` (default `true`) — auto-stage файла

---

## 5. Gotchas / edge cases

### `BUILTIN_FALLBACK` должен соответствовать `bd statuses`

`app/composables/useStatuses.ts:44` экспортирует `BUILTIN_FALLBACK: StatusMeta[]` — синхронный sane default на время cold-start (до разрешения async Tauri-команды) и fallback на случай её сбоя. Категории **обязаны** совпадать с выводом `bd statuses --json` — иначе cold-start фильтрация и сортировка дают неверный результат. Защита — guard-тест в `tests/composables/useStatuses.test.ts`.

### Cache-miss в `useStatuses`

`statuses` computed в `useStatuses.ts:84` возвращает `BUILTIN_FALLBACK` при промахе `cacheByPath`. Это фикс из UD2 — до него возвращал `[]`, и дефолт фильтров `useFilters` писался пустым в момент registration в `useProjectStorage.settingsRegistry`.

### `bd statuses` vs `bd status`

- **`bd statuses`** (с `es`) — список валидных статусов + категории. **Правильная команда** для research.
- **`bd status`** (без `es`) — статистика проекта (total/open/closed/blocked counts). Это **не то же самое**.

### bd ≥ 0.57: нет `bd sync`

- Команды `bd sync` больше **не существует**. Использовать **`bd dolt push`** / **`bd dolt pull`**.
- Auto-flush/auto-import покрывают большинство сценариев — JSONL синхронизируется с Dolt без ручного вмешательства.
- Rust-бэкенд в проекте определяет версию через `parse_bd_version()` и выбирает подходящий code path — см `src-tauri/CLAUDE.md`.

### `bd edit` блокирует агентов

`bd edit` открывает `$EDITOR` (vim/nano) и ждёт interactive input → агент зависает. Использовать inline-флаги: `bd update <id> --title="..." --notes="..." --design="..."` — см `.claude/references/bd-commands.md`.

---

## Миграция к гибриду (на будущее, когда БЗ разрастётся)

Сейчас файл читается только по явной ссылке из root `CLAUDE.md`. Если окажется, что контекст нужен **каждый раз при работе с bd-кодом** — поверх reference можно добавить тонкий L3 rule:

```yaml
# .claude/rules/bd-knowledge.md
---
paths:
  - "src-tauri/src/tracker/**"
  - "app/composables/useStatuses.ts"
  - "app/composables/useIssues.ts"
---
См. [.claude/references/bd-knowledge.md](../references/bd-knowledge.md) — категории, источники правды, custom status config, edge-cases.
```

Сейчас не требуется.
