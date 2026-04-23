---
name: managing-epics
description: "Создание и управление epic для cross-domain фич (несколько supervisor'ов). Используй этот скилл ПРОАКТИВНО когда пользователь говорит: создай эпик, большая фича, cross-domain задача, multi-supervisor task, фича требующая Tauri + Vue, cross-layer, сложная фича на несколько слоёв, нужно несколько supervisor'ов. Покрывает: design doc через architect, создание children с dependencies, acceptance per child, sequential dispatch через bd ready, swarm visualization, закрытие epic после всех children."
---

# Managing Epics — cross-domain фичи

> **Execution style** — см. `CLAUDE.md § Workflow Execution Style` (без промежуточных вопросов включая переходы между skill'ами + табличный итоговый отчёт).

Epic нужен когда задача требует нескольких supervisor'ов (Tauri/Rust + Vue + tests), infra + code change, или > 50 строк с неопределённым контрактом между слоями.

**Epic = организационная группа.** Git branch — один на всю фичу; child'ы работают на той же branch последовательно.

## Когда epic vs standalone

| Сигнал | Решение |
|---|---|
| Один tech domain (только frontend, только tracker, только backend) | **Standalone** |
| Несколько supervisor'ов | **Epic** |
| "Сначала X, потом Y" в твоём мышлении | **Epic** |
| Infra + code | **Epic** |
| Tauri command + Vue component + tests | **Epic** |
| Cross-domain < 50 строк с понятным контрактом | **Standalone** (1 supervisor на все слои) |

## Step 1: Create Epic

```bash
bd create "Feature name" -d "Description" --type epic --label {domain}
# Returns: {EPIC_ID}
```

Label эпика = основной затронутый домен.

## Step 2: Design Doc (если cross-domain)

Для многослойных эпиков — dispatch architect FIRST:

```python
Task(
  subagent_type="architect",
  prompt="""Create design doc for EPIC_ID: {EPIC_ID}
Feature: [description]
Output: .designs/{EPIC_ID}.md

Include:
- Tauri command signatures (Rust types, serde shape)
- Vue component contracts (props, emits, exposed methods)
- Shared types (TypeScript ↔ Rust serde)
- Data flow между layers (UI → composable → invoke → Rust → bd CLI)"""
)
```

Link design doc:
```bash
bd update {EPIC_ID} --design ".designs/{EPIC_ID}.md"
```

Шаблон design doc: `.claude/references/design-doc-template.md`.

## Step 3: Create Children с Dependencies

```bash
# First (no deps)
bd create "Create tracker schema migration" -d "..." --parent {EPIC_ID} --label tracker
# Returns: {EPIC_ID}.1

# Second (deps on first)
bd create "Create Tauri commands" -d "..." --parent {EPIC_ID} --deps "{EPIC_ID}.1" --label backend
# Returns: {EPIC_ID}.2

# Third (deps on second)
bd create "Create frontend (Vue components + composable)" -d "..." --parent {EPIC_ID} --deps "{EPIC_ID}.2" --label frontend
# Returns: {EPIC_ID}.3

# Set acceptance для КАЖДОГО child
bd update {EPIC_ID}.1 --acceptance "Миграция применена, cargo check exit 0"
bd update {EPIC_ID}.2 --acceptance "cargo check exit 0; команды возвращают данные при ручном вызове"
bd update {EPIC_ID}.3 --acceptance "Проверить в Tauri dev: [что]. pnpm test зелёный, vue-tsc --noEmit exit 0"
```

Children наследуют label от domain — не от epic.

## Step 4: Dispatch Children (sequential)

Пометить epic как `in_progress` ОДИН РАЗ (при старте первого child):
```bash
bd update {EPIC_ID} --claim
```

Для каждого child при dispatch:
```bash
bd update {CHILD_ID} --claim     # BEFORE dispatch!
START_COMMIT=$(git rev-parse HEAD)
# ... dispatch supervisor ...
```

Использовать `bd ready` чтобы найти разблокированные child'ы. Dispatch **последовательный** (children делят ветку). Параллельно — ТОЛЬКО если children трогают разные файлы полностью.

При закрытии child — `bd ready` снова, dispatch следующий. Повторять до всех done.

## Step 5: Визуализация (опционально)

Для крупных эпиков с > 3 children:
```bash
bd graph {EPIC_ID}              # DAG зависимостей (ASCII)
bd graph check                  # Циклы, orphans
bd swarm validate {EPIC_ID}     # Проверка структуры перед dispatch
```

## Step 6: Close Epic

После того как ВСЕ children `accepted`:
```bash
bd close {EPIC_ID}  # Закрывает epic и всех children
```

Хук `validate-epic-close.sh` блокирует попытку закрыть epic, у которого остались open children — fix список через `bd children {EPIC_ID}`.
