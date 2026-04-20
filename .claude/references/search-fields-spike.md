# Search Fields Spike — расширение bd_list до полных полей

**Bead:** `beads-task-issue-tracker-du6` (spike, P3)
**Date:** 2026-04-20
**bd version:** 1.0.2 (Homebrew)
**Потребитель:** bead `nif` (имплементация расширения поиска).

## TL;DR

**Рекомендация: переключить `bd_list` IPC с `bd list --json` на `bd export`.**

- `bd export` возвращает все 4 недостающих поля: `acceptance_criteria`, `design`, `notes` (= `working_notes`), `comments`.
- На 997 issues `bd export` **быстрее** baseline `bd list --all --json`: **1.15 s vs 1.25 s** (p50, 5 прогонов, warmup 1).
- Цена: размер JSON +38% (1.93 MB vs 1.40 MB на 1000 issues) + нужен фильтр записей `._type == "memory"` (в export они идут смешанно с issues).
- Вариант `bd list --long --json` отпадает: флаг `--long` не влияет на JSON-вывод (те же 12 полей что без него).

Стоимость для bead `nif`: ~2-3 часа (переключить один IPC + добавить serde-поля + unit-тест на фильтр memories). Никаких архитектурных изменений.

## 1. Проблема

Bead `kqc` добавил клиентский search по 4 полям (id/title/description/labels) через `useSearch`. Unit-тесты проходили на ad-hoc фикстурах с заполненными `workingNotes/acceptanceCriteria/designNotes/comments` — **зелёные**. На живых данных поиск по этим 4 полям **молча не срабатывал**, потому что `fetchIssues` → `bd_list` IPC → `bd list --json` не возвращает эти поля.

Источник истины: memory `bd-list-fields-limited` (см. `bd memories bd-list-fields-limited`).

Структуру `transform_issue` в `src-tauri/src/lib.rs:624` (поля `working_notes/design_notes/acceptance_criteria/comments`, lines 390-403) править не надо — она уже соответствует полному набору, заполняется только из `bd show` сейчас.

## 2. Кандидаты

| # | Команда | Полные поля? | Комментарий |
|---|---------|--------------|-------------|
| a | `bd list --long --json -n 0` | **НЕТ** | `--long` меняет только human-readable text-output. JSON идентичен `bd list --json`. Отпадает. |
| b | `bd export` | **ДА** (все 4 + bonus) | Emits JSONL. Включает `acceptance_criteria/design/notes/comments/assignee/dependencies/...`. Bonus: быстрее baseline. |
| c | Batch `bd show <id> --json` per issue | Да | N+1 subprocess. 997 × ~0.3 s ≈ 300 s. Неприемлемо для polling. Только как lazy-fetch при открытии палитры — но это другая архитектура, не расширение `bd_list`. |
| d | `bd list --desc-contains=<q> --notes-contains=<q> …` server-side filter | Частично | Покрывает только `description` + `notes`. Нет флагов для `acceptance_criteria`/`design`/`comments`. Нужны 2-4 параллельных вызова + client-side OR-merge. Не решает проблему доступности данных — только фильтрацию. |

## 3. Замеры

**Методология:** 6 прогонов на команду, первый отбрасывается (warmup), p50 = третий из 5 отсортированных, p95 ≈ max из 5. Измерено через `/usr/bin/time -p`. Оба датасета локальные Dolt-проекты, "тёплый" кэш FS.

### Current project (142 issues, ~60 KB baseline)

| Команда | p50 (s) | p95 (s) | Output size |
|---------|---------|---------|-------------|
| `bd list --json -n 0` (baseline) | 0.14 | 0.14 | 59 957 B |
| `bd list --long --json -n 0` | 0.14 | 0.15 | 59 957 B (идентичен baseline) |
| **`bd export`** | **0.28** | **0.29** | **319 012 B** |
| `bd list --desc-contains=test --json -n 0` | 0.11 | 0.11 | 23 354 B (отфильтровано) |

### invest_fund_sharks (997 issues — живой стресс-датасет)

| Команда | p50 (s) | p95 (s) | Output size |
|---------|---------|---------|-------------|
| `bd list --all --json -n 0` (baseline) | 1.25 | 1.27 | 1 404 601 B |
| `bd list --all --long --json -n 0` | 1.28 | 1.35 | 1 404 601 B |
| **`bd export`** | **1.15** | **1.21** | **1 933 625 B** |
| `bd list --all --desc-contains=bug --json -n 0` | 0.85 | 0.91 | 53 558 B (отфильтровано) |

**Ключевое наблюдение:** на 1000 issues `bd export` **на 8% быстрее** baseline — при том что отдаёт в 1.38× больше данных. Предположительная причина: `bd list` делает tree-resolve + priority sort + pretty-format, `bd export` — straight dump из БД.

На 142 issues export в 2× медленнее baseline (0.28 vs 0.14), но в абсолютных числах это +140 ms — при polling с интервалом ≥5 s пренебрежимо.

## 4. Совместимость

- `bd export` присутствует начиная с bd 1.0 (проверено на 1.0.2). Поле `_type` в records для различения memories/issues тоже стабильно.
- Для bd 0.x (pre-1.0) нужен fallback — `bd export` в 0.x работал по-другому или отсутствовал; текущий `parse_bd_version()` уже есть в `src-tauri/` и умеет gating.
- **Рекомендация для `nif`:** при `major >= 1` использовать `bd export`; при `major == 0` оставить старый путь (`bd list --json` + `bd show` для деталей) — ровно как уже сделано для других version-gated мест.

## 5. Риски и mitigations

| Риск | Mitigation |
|------|------------|
| Размер JSON: 1000 issues × полные notes/comments = ~2 MB. IPC в Tauri тянет это через serde + JSON-копию. | Пренебрежимо в абсолютных числах: Tauri легко тянет десятки MB. На 10 000 issues (гипотеза) нужен паджинг — но это отдельная проблема. |
| Память фронтенда: все issues с полными полями в `issues.value`. | В `invest_fund_sharks` ~2 MB string data — на 2 GB RSS браузера незначимо. |
| `bd export` включает memories (`_type == "memory"`). | Один фильтр в Rust: `records.into_iter().filter(\|r\| r.get("_type").is_none())`. 5 строк кода. |
| `bd export` в будущих версиях может включать новые record types. | Явный whitelist: принимать только records без `_type` (= issue) или `_type == "issue"` если bd начнёт метить. |
| Polling hot-path: `bd_list` вызывается часто (useAdaptivePolling). На 1000 issues выигрыш (−100 ms), на 100 — проигрыш (+140 ms). | Net: нейтрально-позитивно. Если критично для мелких проектов — оставить `bd list --json` для быстрого polling, `bd export` для on-demand search refresh. Но это усложнение, не рекомендуется на старте. |

## 6. Рекомендация для bead `nif`

**Делать (b): заменить `bd list --json` на `bd export` в `bd_list` IPC.**

Concrete scope:
1. В `src-tauri/src/lib.rs:2824` (`bd_list`) сменить команду на `bd export` при `bd_major >= 1`.
2. Распарсить JSONL (line-delimited), отфильтровать `._type == "memory"`.
3. Убедиться что `transform_issue` корректно читает новые поля (должно — поля уже есть в struct).
4. Unit-тест: фикстура из 3 issues + 1 memory → 3 issues на выходе, все с полными полями.
5. Acceptance: открыть палитру поиска, ввести слово из `workingNotes` любого issue → issue найден.

**Fallback для bd 0.x:** `major == 0` → остаётся `bd list --json`, search ограничен 4 полями (UX-tooltip в палитре «на старой bd работает поиск только по title/description/id/labels»).

Оценка стоимости: **2-3 часа** (1 file Rust + 1 test + smoke-acceptance).

**Не делать (c), (d)** — обоснование в таблице выше. Не делать (a) — не работает.

## 7. Non-goals (что spike не покрывает)

- Оптимизация размера передачи через IPC (стриминг/chunking) — преждевременно, не bottleneck.
- FTS-индекс на стороне bd — белое пятно в roadmap'е bd, вне scope spike.
- Перформанс `useSearch` при больших строках — другой bead, если всплывёт.
