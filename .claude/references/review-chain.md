# Bead Status Lifecycle — детали

Диаграмма и ownership boundary живут в L1 `CLAUDE.md`. Этот файл — детали, которые не нужны в каждой сессии.

## Сокращённые пути

- **Без `acceptance_criteria`:** `reviewed → closed` (skip `accepted`).
- **Fast path:** `open → in_progress → closed` (skip весь review chain) — для todo и мелких правок, которые не нуждаются в code-simplifier / code-reviewer.

## Полная цепочка

```
open → in_progress → inreview → simplified → reviewed → accepted → closed
  ↑        ↑            ↑           ↑           ↑          ↑         ↑
create  --claim     supervisor  orchestr.   orchestr.  orchestr.  bd close
                    после push  после       после      после     --suggest-next
                                simplify    review     acceptance
```

## Кто какой статус ставит

- `in_progress` → supervisor через `bd update {ID} --claim` (атомарный claim: assignee + in_progress). Это lock — предотвращает захват бида другим агентом.
- `inreview` → supervisor после commit+push.
- `simplified` → **orchestrator** после code-simplifier.
- `reviewed` → **orchestrator** после code-reviewer APPROVED.
- `accepted` → **orchestrator** после acceptance checks.
- `closed` → **orchestrator** через `bd close {ID} --suggest-next`.

Supervisor'ы НЕ ставят `simplified`/`reviewed`/`accepted` и не вызывают `bd close` — это работа orchestrator'а. Хук `block-supervisor-close-and-signing.sh` блокирует попытки.
