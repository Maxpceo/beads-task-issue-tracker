# Bead Status Lifecycle — shortcuts

Полная цепочка и ownership (`in_progress` / `inreview` → supervisor; `simplified` / `reviewed` / `accepted` / `closed` → orchestrator) задокументированы в L1 `CLAUDE.md` → раздел `### Bead Status Lifecycle`. Здесь — только сокращённые пути и hook-детали, которые не нужны в каждой сессии.

## Сокращённые пути

- **Без `acceptance_criteria`:** `reviewed → closed` (skip `accepted`).
- **Fast path:** `open → in_progress → closed` (skip весь review chain) — для todo и мелких правок, которые не нуждаются в code-simplifier / code-reviewer.

## Orchestrator skill для review chain

Orchestrator-процедура от `inreview` до `closed` — **skill `reviewing-code`** (simplify через built-in `simplify` → двухэтапный code review → RAMS/WIG для Vue → locale-sync → acceptance → close).

## Hook enforcement

- `block-supervisor-close-and-signing.sh` — блокирует попытки supervisor'ов вызывать `bd close` или ставить `simplified`/`reviewed`/`accepted`.
- `validate-review-chain.sh` (если включён) — проверяет переход статусов в валидной последовательности.
- `validate-completion.sh` — проверяет что orchestrator предоставил свежие evidence перед переходом в `closed`.
