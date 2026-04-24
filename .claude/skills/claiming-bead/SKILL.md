---
name: claiming-bead
description: "Claim-first на триггер-фразы пользователя с авто-входом в Plan Mode. Используй этот скилл ПРОАКТИВНО когда пользователь говорит: «возьми <ID>», «начни выполнять <ID>», «делай <ID>», «автономно <ID>», «займись <ID>», «работай над <ID>», «claim <ID>», «берём <ID>», «возьми bead в работу», «начни bead», «claim задачу», «запусти задачу» (с ID или без). Если <ID> не указан — сначала `bd ready` + AskUserQuestion («какой bead взять?»), затем стандартный claim + EnterPlanMode. Обязывает orchestrator: (1) bd update --claim ПЕРВЫМ не-readonly действием, (2) auto EnterPlanMode для Supervisor Path, (3) если orchestrator уже в Plan Mode на момент триггера — попросить пользователя выйти из Plan Mode (claim недоступен)."
---

# Claiming Bead — claim-first workflow

> **Execution style** — см. `CLAUDE.md § Workflow Execution Style` (без промежуточных вопросов включая переходы между skill'ами + табличный итоговый отчёт).

Триггер-фразы: «возьми <ID>», «начни выполнять <ID>», «делай <ID>», «автономно <ID>», «займись <ID>», «работай над <ID>», «claim <ID>», «берём <ID>».

Цель: исключить ситуацию, когда orchestrator тратит контекст на investigate ДО claim'а, а потом обнаруживает что bead уже взят другой сессией или закрыт. Claim — первое не-readonly действие, сразу фиксирует намерение.

## Step 1. Проверить статус bead'а (read-only)

```bash
bd show <ID>
```

Разветвление:
- **closed / done** → СТОП. Не реанимировать. Сообщить пользователю, предложить follow-up через `bd create "Fix: ..." -d "Follow-up to <ID>"` + `bd dep relate <NEW> <OLD>`.
- **in_progress, assignee == me** → idempotent, `bd update --claim` пройдёт без изменений.
- **in_progress, assignee ≠ me** → предупредить пользователя («bead занят другой сессией / агентом — точно claim?»). Продолжать только после подтверждения.
- **open / blocked** — нормальный путь, переходим к Step 2.

`bd show` — read-only, допустим даже в Plan Mode (см. Step 0 ниже).

## Step 0 (если актуально). Plan Mode race

Если orchestrator уже в Plan Mode на момент триггер-фразы — `bd update --claim` заблокирован `block-orchestrator-tools.sh` (non-readonly). Попросить пользователя одной фразой выйти из Plan Mode, после выхода — Step 2.

Не пытайся обойти — hook надёжнее спонтанных решений.

## Step 2. Claim немедленно

```bash
bd update <ID> --claim
```

Это первое non-readonly действие. Hook enforcement для контекста (`enforce-bead-enrichment.sh` ветка C) стоит на `bd create`, **не** на `--claim` — claim проходит без дополнительных gate.

Если `bd show` показал enriched description/comments — Session A наполнила bead, контекст уже в prompt после `bd show`. Если bead создан до `INSTALL_DATE=2026-04-20` (grandfathered) или enrichment не видно — начинай с investigate в Plan Mode (Step 4), это и есть ожидаемый fallback.

## Step 2.5. Работа в worktree (если пользователь запросил)

**Если пользователь запросил работу в worktree** (фразы «в worktree», «создай worktree», «изолированно», «в отдельной ветке/окружении»):

**Именование ветки.** Выбирает orchestrator по типу задачи в Conventional-namespace: `fix/…` (bug), `feat/…` (feature), `docs/…` (doc-only), `chore/…` (infra/config), `refactor/…`, `perf/…`, `test/…`. Включай bead ID в имя для навигации — например `fix/bd-<bead-id>`, `feat/bd-<bead-id>`, `refactor/bd-<bead-id>`. Конкретный slug — на усмотрение orchestrator'а. `session-start.sh` auto-cleanup читает имя ветки через `git branch --show-current` внутри worktree — префикс `bd-` больше не обязателен.

```bash
# 1. Родительская директория (идемпотентно)
mkdir -p ~/Projects/worktrees/beads-task-issue-tracker

# 2. Создать worktree + ветку (подставь <type> и <bead-id>)
WT_NAME="<type>/bd-<bead-id>"   # пример: fix/bd-6nm, feat/bd-u9v
bd worktree create ~/Projects/worktrees/beads-task-issue-tracker/"$WT_NAME" --branch "$WT_NAME"

# 3. Обязательный setup (.env symlink + pnpm install)
./scripts/setup-worktree.sh ~/Projects/worktrees/beads-task-issue-tracker/"$WT_NAME"

# 4. Дальше вся работа идёт из worktree
cd ~/Projects/worktrees/beads-task-issue-tracker/"$WT_NAME"
```

Без `setup-worktree.sh` в worktree не будет `.env` и `node_modules` — supervisor упадёт на первом же `pnpm test`. Детали layout'а: `.claude/references/bd-worktrees.md`.

Первый `cargo check` / `pnpm tauri:dev` в новой worktree скомпилирует Rust с нуля (минуты) — это ожидаемо. Каждая worktree имеет свой `src-tauri/target/` (shared target ломает Cargo lock и cargo clean).

Если worktree не запрошен — переходи к Step 3 как обычно.

## Step 3. Определить путь: Fast Path vs Supervisor Path

**Fast Path** — все условия true:
- Не на main/master
- 1 файл, <20 строк, без новых классов/функций/импортов cross-file
- **Пользователь явно подтвердил:** «без плана» / «Fast Path» / «правь сам» / «не планируй»

Если пользователь просто сказал «делай <ID>» — это **не** явное подтверждение Fast Path. Default = Supervisor Path (Step 4).

Если Fast Path:
- Отредактировать файл напрямую
- Commit + `bd close <ID>` — skip статусов inreview/simplified/reviewed/accepted

## Step 4. Auto EnterPlanMode → Plan → Dispatch

Supervisor Path (default):

1. EnterPlanMode
2. Investigate: Glob / Grep / Read
3. AskUserQuestion — уточнения по архитектуре / alternatives
4. ExitPlanMode с approved planом
5. Сохранить PLAN-comment в bead (шаблон: `.claude/references/workflow-templates.md` §2)
6. Если bead создан до claim'а и не enriched — дополнить enrichment через `bd comments add` (опционально, рекомендуется)
7. Запустить skill `pre-dispatch` — он сделает read-only проверку (bead уже `in_progress`, assignee = me), соберёт BRANCH/START_COMMIT, выберет supervisor'а и **немедленно вызовет** `Task(...)` inline. Не делай текстовую паузу между `ExitPlanMode` и pre-dispatch.

## Разведение с другими skills

- **`claiming-bead`** = первое действие ПОСЛЕ триггер-фразы пользователя: claim + вход в Plan Mode.
- **`pre-dispatch`** = ПОСЛЕ утверждённого плана: собирает метаданные (BRANCH, START_COMMIT), выбирает supervisor'а и **немедленно вызывает** `Task(subagent_type=...)` inline без промежуточного вопроса.
- **`reviewing-code`** = ПОСЛЕ `inreview`: simplify → code review → acceptance → close.
- **`land`** = ПОСЛЕ close: push на remote.

Не запускай `pre-dispatch` пока plan не approved.
