# Workflow Templates

Шаблоны для bead comments и supervisor dispatch. Канонические формулировки здесь; в CLAUDE.md — короткая ссылка.

## 1. Bead Creation with Embedded Enrichment

Enrichment встраивается прямо в `--description` при `bd create` — чтобы следующая сессия (Session B, другой worktree / следующий день) открыла bead и сразу видела контекст БЕЗ повторного investigate. Hook `enforce-bead-enrichment.sh` ветка C **блокирует** `bd create` без markers `### Files / ### Current state / ### Target state`.

**Heredoc pattern (канонический):**

```bash
bd create --title "<summary>" --description "$(cat <<'EOF'
<краткое резюме: что и зачем>

### Files
- app/composables/useIssues.ts:123-145
- src-tauri/src/tracker/mod.rs:40-80
- app/components/IssueList.vue:10-40

### Current state
<фрагмент кода / текущее поведение / контракт>

### Target state
<фрагмент кода / ожидаемое поведение>

### Investigation findings
- grep 'foo' → 3 места
- ADR-027 применим
- Связан с bead-xxx

### Pattern reference
Аналог: app/composables/useFilters.ts или src-tauri/src/lib.rs
EOF
)" --label {domain}
```

**Альтернатива при длинном контексте** — `--body-file`:

```bash
# Записать markers в файл, затем
bd create --title "..." --body-file /tmp/bead-context.md --label {domain}
```

Hook читает `--body-file` / `--design-file` и проверяет markers внутри.

**Override** (использовать только для осмысленных исключений — wisp-эксперименты, follow-up stub'ы без деталей):

```bash
SKIP_ENRICH_CHECK=1 bd create --title "..." -d "короткое описание" --label {domain}
```

**Exempt автоматически** (без override): `--type epic`, `--ephemeral`, `--from-markdown`, `--from-graph`, `--file` (batch).

Для Fast Path (<20 строк, 1 файл, без bead'а) шаг не нужен — bead не создаётся.

## 2. PLAN Comment (после Plan Mode approval)

После одобрения плана зафиксировать его в bead — чтобы план пережил сессию и был виден при redispatch/review.

```
bd comments add {ID} "PLAN (approved YYYY-MM-DD):

Problem: <1-2 предложения>
Approach: <что делаем>
Rejected alternatives: <что рассматривали и почему отказались>
Files to change: <список с путями>
Acceptance: <как проверим>"
```

**Rejected alternatives — обязательны:** защищают от дрейфа при redispatch (нельзя «забыть» и сделать по-другому). Reviewer этапа 1 (spec compliance) сверяется именно с этим комментарием.

Когда не нужно: Fast Path (Plan Mode не применяется), мелкий фикс без Plan Mode, эпики (для них `.designs/{EPIC_ID}.md`).

## 3. Dispatch Prompt Skeleton

Шаблон `Task(...)` для supervisor'а. `BRANCH` обязателен — orchestrator получает через `git branch --show-current`.

```
Task(
  subagent_type="{tech}-supervisor",
  prompt="BEAD_ID: {id}
BRANCH: {current_branch}
START_COMMIT: {hash}

Fix: [1 предложение — supervisor прочитает детали из bead comments]

## Before you begin
Если что-то неясно — остановись и задай вопросы ДО начала работы (требования,
подход, зависимости, предположения). Это не штраф, это норма. Не угадывай.

## When you're in over your head
Можно остановиться и сказать 'эта задача слишком сложная для меня'. Плохая работа
хуже отсутствия работы. Эскалируй со статусом BLOCKED или NEEDS_CONTEXT когда:
- Задача требует архитектурных решений с несколькими валидными подходами
- Нужно понимание кода за пределами предоставленного контекста и ясности нет
- Ты не уверен что твой подход корректен
- Задача требует реструктуризации, которую план не предусматривал
- Ты читаешь файл за файлом без прогресса в понимании системы"
)
```

Supervisor читает bead comments для полного investigation context, затем работает уверенно.

## 4. Phase-Boundary Dispatch (stop-at-deliverable)

Когда orchestrator хочет остановить supervisor'а на промежуточном deliverable (например, supervisor пишет код + commit локально, orchestrator потом делает review + push отдельно) — используется rigid termination language.

```
Task(
  subagent_type="{tech}-supervisor",
  prompt="BEAD_ID: {id}
BRANCH: {current_branch}
START_COMMIT: {hash}

TASK: [description]

DELIVERABLE (Phase X of Y):
Return ONLY after:
1. [concrete step, e.g., commit локально]
2. [concrete step, e.g., return completion report]

Orchestrator handles remaining phases (push, status transitions, close) в отдельном dispatch."
)
```

**Два слоя защиты:**

1. **Rigid language** — soft hint ("Return ONLY after..."). Работает в большинстве случаев.
2. **Hook `block-supervisor-close-and-signing.sh`** — hard gate: блокирует `git push`, `bd close`, `bd update --status simplified|reviewed|accepted` из subagent context. Срабатывает даже если supervisor проигнорирует rigid language (instruction hierarchy: agent body перекрывает dispatch-prompt).

**Когда использовать:** многофазные pipeline'ы, smoke test с sandbox, human review между commit и push.

**Когда НЕ нужно:** обычный supervisor workflow — default: supervisor commit + `inreview` через on-completion, push делает orchestrator через `/land`. Phase-Boundary Dispatch нужен только для многофазных кастомных pipeline'ов поверх этого default'а.
