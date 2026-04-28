---
name: reviewing-code
description: "Code review workflow после завершения supervisor'ом работы (bead в статусе inreview). Используй этот скилл ПРОАКТИВНО когда: supervisor вернул BEAD COMPLETE, bead попал в inreview, пользователь говорит «review bead», «запусти ревью», «проверь результат супервизора», «dispatch reviewer», «review this work». Покрывает simplify (built-in skill `simplify`), двухэтапный code-reviewer (spec-compliance + quality), RAMS + web-interface-guidelines для Vue-компонентов, locale-sync check для i18n-изменений, knowledge capture через bd remember, acceptance через Tauri dev / chrome-devtools MCP / agent-browser, закрытие bead через bd close --claim-next."
---

# Reviewing Code — полный review workflow оркестратора

Supervisor вернул `inreview` → запускай этот skill. Цепочка статусов:

```
inreview → simplified → reviewed → accepted → closed
           Step 1       Step 2     Step 3     Step 4
```

> **Execution style** — см. `CLAUDE.md § Workflow Execution Style` (без промежуточных вопросов включая переходы между skill'ами + табличный итоговый отчёт).

В начале **проверь** что текущий статус bead'а действительно `inreview`:

```bash
bd show {BEAD_ID} --json | jq -r '.[0].status'
```

Если не `inreview` — выход (claim делает `claiming-bead`, dispatch — `pre-dispatch`; запусти их сначала). Хуки `validate-review-chain.sh` + `validate-completion.sh` сторожат валидность переходов на bd-уровне; порядок simplify → review → accept — orchestrator-дисциплина (ответственность skill'а), не enforced хуками.

## Universal sweep — упомянутые, но не созданные bead'ы

Каждый review-step (1 simplify, 2 code-review, 2.5 RAMS/WIG, 3 acceptance) **ОБЯЗАН** после получения summary от skill'а / агента:

1. Найти в summary findings с маркерами:
   - simplify: `follow-up bead`, `отдельным bead`, `scope-cut`, `вне scope`, `out of scope`, `not worth fixing now`
   - code-reviewer: `pre-existing`, `существовал до`, `баг не введён этим`, `не блокирует approval`
   - RAMS / WIG: `non-critical follow-up`, `можно отложить`, `улучшение не блокирующее`
   - orchestrator: `отложим в follow-up`, `починим отдельным bead`

2. Каждый match — запись в локальный `FOLLOWUPS`-список (в рабочем контексте orchestrator'а, не на диск) с полями:
   - `source-step` (`simplify` / `code-review` / `RAMS` / `acceptance`)
   - `title` (вытащенный или сформулированный из контекста finding'а)
   - `rationale` (1-2 строки, *почему* отдельный bead, не текущий)
   - `suggested-label` (по домену: simplify → `dx`, RAMS → `ui`, code-reviewer → label текущего bead'а, acceptance → label текущего bead'а)
   - `suggested-type` (`bug` для pre-existing / RAMS critical, `task` иначе)
   - `confidence` (`certain` / `uncertain`)

3. Workflow **НЕ прерывается**. Идём к следующему step'у.

Список фраз — не закрытый. Если видишь явное намерение «нужно отдельной задачей» в иной формулировке — добавляй finding в `FOLLOWUPS` и в финальном отчёте предложи дописать фразу в этот список.

## Step 1: Simplify (ОБЯЗАТЕЛЬНО перед review)

Запусти built-in skill `simplify` — review changed code for reuse, quality, and efficiency.

```python
Skill(skill="simplify")
```

После возврата:

```bash
bd comments add {BEAD_ID} "SIMPLIFY: DONE. [резюме]"
# или (docs/config only):
bd comments add {BEAD_ID} "SIMPLIFY: SKIPPED. docs/config only"
bd update {BEAD_ID} --status simplified
```

**Multi-dispatch:** если supervisor'а диспатчили несколько раз — simplify ОДИН РАЗ в конце, перед финальным review.

## Step 2: Code review (двухэтапный)

```python
Task(
  subagent_type="code-reviewer",
  prompt="""BEAD_ID: {BEAD_ID}
BRANCH: {branch}
START_COMMIT: {hash}

Review git diff {hash}..HEAD в ДВА ЭТАПА.

## Этап 1: Spec compliance (ПЕРВЫМ)

Прочитай контекст через `bd show {BEAD_ID}` и `bd comments {BEAD_ID}`. Обрати внимание на:
- Description (что требовалось)
- Acceptance criteria (как проверить)
- PLAN: комментарий (одобренный план)
- Context-комментарий с files/current state/target state

Сверь git diff с контекстом и найди:
- Missing requirements — что требовалось, но не реализовано
- Extra work — что реализовано, но не требовалось (over-engineering)
- Misunderstandings — правильное требование интерпретировано неправильно

НЕ ДОВЕРЯЙ отчёту супервизора. Читай фактический код в diff, сверяй построчно.

Если расхождения → verdict `NOT APPROVED [SPEC_GAP]`. Этап 2 НЕ выполнять.

## Этап 2: Code quality (только если этап 1 passed)

- Чистота, именование, DRY, YAGNI
- Vue Composition API patterns (`ref` / `computed` / `watch`, не `data()`)
- Tauri command signatures: `serde` derive, `Result<T, String>` для команд
- TypeScript strict для frontend; camelCase для TS, snake_case только в Rust
- Тесты проверяют поведение, а не моки
- Логирование: `logFrontend()` / `log_*!`, без `console.*` в `app/`

## Verdict
- `APPROVED` — оба этапа прошли
- `NOT APPROVED [SPEC_GAP]` — расхождение с требованиями
- `NOT APPROVED [QUALITY]` — код не соответствует качеству
"""
)
```

### Deep review для крупных изменений

Для cross-domain фич или изменений > 200 строк:

```bash
/pr-review-toolkit:review-pr all       # Полный review (несколько агентов)
/pr-review-toolkit:review-pr errors    # Silent failures
/pr-review-toolkit:review-pr tests     # Покрытие тестами
```

### Verdict запись

```bash
bd comments add {BEAD_ID} "CODE REVIEW: APPROVED. [summary]"
# или
bd comments add {BEAD_ID} "CODE REVIEW: NOT APPROVED [метка]. [issues]"
bd update {BEAD_ID} --status reviewed   # ТОЛЬКО при APPROVED
```

**NOT APPROVED** → redispatch supervisor с fix list, затем re-review. Статус остаётся `simplified`.

## Step 2.5: Frontend-bead — RAMS + WIG (обязательно для label=frontend / ui)

**Важно:** RAMS и web-interface-guidelines — plugin skills. Классические subagents их НЕ наследуют и НЕ могут вызывать `Skill()`. Поэтому **orchestrator** запускает их здесь, после `reviewed`, для всех modified компонентов.

```python
# Для каждого модифицированного .vue компонента:
Skill(skill="rams", args="path/to/Component.vue")
Skill(skill="web-interface-guidelines")
```

Результаты:

```bash
bd comments add {BEAD_ID} "Reviews: RAMS {X}/100, WIG {passed|issues: ...}. Fixed: [issues if any]"
```

Если RAMS находит CRITICAL accessibility issues или WIG — violations → вернуть для исправления (redispatch vue-supervisor с fix list).

## Step 2.6: Knowledge Capture (опционально)

После APPROVED:

```bash
bd remember "инсайт" --key short-key
```

Когда записывать:

- Неочевидный баг или gotcha
- Архитектурный паттерн для переиспользования
- Ограничение библиотеки/API не в документации (например, reka-ui Select внутри Dialog ломается)
- Решение, которое далось не с первой попытки

Когда НЕ записывать:

- Рутинная задача без сюрпризов
- Инсайт уже записан (проверить `bd memories "keyword"`)

## Step 2.7: Locale-sync check (если diff трогает `$t(...)` или `i18n/locales/`)

Если в diff появились новые `$t('...')` ключи — проверить, что они присутствуют в обоих locale файлах:

```bash
ADDED_KEYS=$(git diff {START}..HEAD app/ | grep -oE "\\\$t\\(['\"][^'\"]+" | sed -E "s/\\\$t\\(['\"]//" | sort -u)
for k in $ADDED_KEYS; do
  jq -e --arg k "$k" 'getpath($k | split("."))' i18n/locales/en.json >/dev/null 2>&1 || echo "Missing EN: $k"
  jq -e --arg k "$k" 'getpath($k | split("."))' i18n/locales/ru.json >/dev/null 2>&1 || echo "Missing RU: $k"
done
```

Также: `jq -S 'paths(scalars)' i18n/locales/en.json | diff - <(jq -S 'paths(scalars)' i18n/locales/ru.json)` — должен вернуть пустой diff. Полные правила: `.claude/rules/locale-sync.md`.

Если есть missing keys или drift → redispatch vue-supervisor с fix list.

## Step 3: Acceptance (если acceptance_criteria set)

**Триггер:** поле `acceptance_criteria` заполнено. Хук блокирует close если нет `ACCEPTANCE:` в comments.

**Автотесты (orchestrator):** выполнить каждый пункт из acceptance, записать результат с exit code + выводом (правило Evidence before claims).

**Tauri app (визуальная проверка):** для UI-фич в Tauri-окне:

- Запусти `pnpm tauri:dev` (но сначала kill zombies — см. `src-tauri/CLAUDE.md`).
- Используй `mcp__tauri__*` tools для click/screenshot/query.
- Альтернатива: `mcp__chrome-devtools__*` на dev-server (`pnpm dev`, без Tauri shell).
- Если оба недоступны — `agent-browser open http://localhost:3000/page` + `agent-browser snapshot -i | grep ...`.

**Ручная (user confirmation):** сообщить пользователю что проверить, дождаться подтверждения. Использовать когда автотесты невозможны (визуальный регресс, поведение в реальном Tauri-окне).

```bash
bd comments add {BEAD_ID} "ACCEPTANCE: PASSED. [что проверено + выводы команд]"
bd update {BEAD_ID} --status accepted
```

Если проблемы — redispatch supervisor с описанием.

## Step 3.5: Sweep follow-ups (перед Step 4)

Если `FOLLOWUPS` непуст:

1. Для каждой записи с `confidence=certain`:

   ```bash
   SKIP_ENRICH_CHECK=1 bd create \
     --title "Follow-up из {source-step} {BEAD_ID}: {title}" \
     -d "{rationale}" \
     --label {suggested-label} \
     --type {suggested-type}
   ```

   Молча. Сохраняй полученный ID.

2. Записи с `confidence=uncertain` — в локальный `QUESTIONS`-список (обработается в Step 4).

3. Сводка в comment текущего bead'а:

   ```bash
   bd comments add {BEAD_ID} "FOLLOWUPS: создал N bead'ов: [ID1, ID2, ...]. Сомнений: M."
   ```

4. В финальный отчёт workflow (см. CLAUDE.md «Workflow Execution Style» §2) добавь две строки в итоговую таблицу:

   | Follow-ups | N созданных, M сомнений |
   | FOLLOWUP IDs | bd-XXX, bd-YYY |

Если `FOLLOWUPS` пуст — пропусти Step 3.5 и переходи к Step 4 без записи в comment.

## Step 4: Close

Перед `bd close`: если `QUESTIONS` непуст — **ОДИН** AskUserQuestion с batch-форматом «N findings под вопросом, как поступить с каждым: завести как отдельный / объединить с X / отбросить». Это единственный вопрос за весь workflow и приходится строго на «scope vs follow-up» — категория, разрешённая в CLAUDE.md как «точка решения вне плана».

После ответа:

- «завести» / «объединить» → `SKIP_ENRICH_CHECK=1 bd create ...` либо `bd update {existing-id} ...`. Полученные ID добавь в финальный отчёт.
- «отбросить» → `bd comments add {BEAD_ID} "DROPPED: [список с обоснованием]"` в исходный bead.

Затем:

```bash
bd close {BEAD_ID} --claim-next   # Закрыть + claim следующей готовой задачи
# или --suggest-next для просмотра разблокированных
```

## Skip conditions (review may be skipped)

- Fast path (orchestrator direct edits, <20 строк, 1 файл)
- Documentation-only (`.md`, комментарии)
- Configuration-only (`.json`, `.yaml`)
- Пользователь явно сказал "skip review"

Override когда хук блокирует: `bd close {ID} --force`
