---
name: claiming-bead
description: "Claim-first на триггер-фразы пользователя с авто-входом в Plan Mode. Используй этот скилл ПРОАКТИВНО когда пользователь говорит: «возьми <ID>», «начни выполнять <ID>», «делай <ID>», «автономно <ID>», «займись <ID>», «работай над <ID>», «claim <ID>», «берём <ID>» (где <ID> — bead ID вида beads-task-issue-tracker-xxxx). Обязывает orchestrator: (1) bd update --claim ПЕРВЫМ не-readonly действием, (2) auto EnterPlanMode для Supervisor Path, (3) если orchestrator уже в Plan Mode на момент триггера — попросить пользователя выйти из Plan Mode (claim недоступен)."
---

# Claiming Bead — claim-first workflow

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
7. Делегировать skill `pre-dispatch` для сбора BRANCH / START_COMMIT и запуска supervisor'а

## Разведение с другими skills

- **`claiming-bead`** = первое действие ПОСЛЕ триггер-фразы пользователя: claim + вход в Plan Mode.
- **`pre-dispatch`** = ПОСЛЕ утверждённого плана: собирает метаданные (BRANCH, START_COMMIT), генерирует шаблон промпта для `Task(subagent_type=...)`.
- **`reviewing-code`** = ПОСЛЕ `inreview`: simplify → code review → acceptance → close.
- **`land`** = ПОСЛЕ close: push на remote.

Не запускай `pre-dispatch` пока plan не approved.
