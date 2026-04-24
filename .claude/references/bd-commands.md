# Beads Commands Reference

Полный справочник команд `bd`. Читать когда нужно вспомнить конкретную команду или пример запроса. Краткий список для L1 root CLAUDE.md содержит только самое ходовое (`bd create`, `bd update --claim`, `bd close`, `bd ready`, `bd merge-slot`).

## Discovery & Query

```bash
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
```

## Create & Update

```bash
bd create --title="..." --description="..." --type=task --priority=2 --label=dx
bd create --title="..." --type=epic               # Эпик (родитель)
bd create --title="..." --parent={EPIC_ID}        # Child эпика
bd q "Title" -p 1                                 # Quick capture (выводит только ID)
bd update {ID} --claim                            # Атомарный claim (assignee + in_progress)
bd update {ID} --status inreview                  # Явный статус
bd update {ID} --acceptance "1. Тесты. 2. ..."    # Acceptance criteria
bd update {ID} --notes / --design / --title       # Поля бида
```

## Todo (лёгкие задачи)

```bash
bd todo add "Fix typo"                            # Создать (P2 task)
bd todo                                           # Список открытых
bd todo done {ID}                                 # Закрыть
```

## Close

```bash
bd close {ID}                                     # Закрыть
bd close {ID1} {ID2} ...                          # Массово (эффективнее)
bd close {ID} --suggest-next                      # + показать разблокированные
bd close {ID} --claim-next                        # + сразу взять следующую
```

## Dependencies

```bash
bd dep add {ID} {DEPENDS_ON}                      # Добавить зависимость
bd dep relate {NEW_ID} {OLD_ID}                   # Трассировка без зависимости
bd blocked                                        # Все заблокированные
```

## Formulas & Batch

```bash
bd formula list                                   # Доступные формулы
bd mol pour <name> --var key="value"              # Создать эпик из формулы
bd mol distill {EPIC_ID} name                     # Извлечь формулу из удачного эпика
bd cook <name> --dry-run --var key="v"            # Предпросмотр без создания
bd batch -f operations.txt                        # Атомарные операции из файла
```

## State & Parallel Work

```bash
bd set-state {ID} dim=value --reason "why"        # Оперативное состояние
bd worktree create <path> --branch <branch>       # Worktree для параллельной работы
bd merge-slot acquire / release                   # Сериализация push (см. L1 CLAUDE.md)
```

**Worktree policy:** `<path>` — всегда абсолютный external (`~/Projects/worktrees/beads-task-issue-tracker/<name>`). Короткая форма `<name>` блокируется hook'ом `block-worktree-in-repo.sh`. Детали: [bd-worktrees.md](./bd-worktrees.md).

В сессии: push через skill **`land`**. Финальный merge в main: skill **`merge-to-main`**. Оба используют `bd merge-slot`.

## Lifecycle Hygiene

```bash
bd defer {ID} --until="date"                      # Отложить до даты
bd supersede {ID} --with={NEW_ID}                 # Заменить новым
bd gc --dry-run                                   # Сборка мусора (предпросмотр)
bd human {ID}                                     # Флаг для человеческого решения
bd memories <keyword> / bd remember / bd forget   # Persistent memory
```

## Полезные запросы (bd query)

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

## Формулы для типовых задач

3 готовых формулы в `.beads/formulas/` (адаптированы под Vue/Nuxt + Tauri):

```bash
bd formula list                                                         # Список
bd mol pour vue-feature --var feature_name="Dashboard"                  # component → composable → integration
bd mol pour tauri-feature --var feature_name="Auth"                     # Rust cmd → bridge → Vue hook
bd mol pour bug-fix --var bug="Login timeout"                           # reproduce → fix → regression test
bd cook vue-feature --dry-run --var feature_name="X"                    # Предпросмотр без создания
bd mol distill {EPIC_ID} my-new-formula                                 # Извлечь формулу из удачного эпика
```
