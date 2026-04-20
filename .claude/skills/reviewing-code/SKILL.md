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

В начале **проверь** что текущий статус bead'а действительно `inreview`:
```bash
bd show {BEAD_ID} --json | jq -r '.[0].status'
```
Если не `inreview` — выход (pre-dispatch / claiming-bead должны быть запущены сначала). Хуки `validate-review-chain.sh` + `validate-completion.sh` сторожат валидность переходов на bd-уровне; порядок simplify → review → accept — orchestrator-дисциплина (ответственность skill'а), не enforced хуками.

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

## Step 4: Close

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

## Pre-existing bugs

Если ревьювер находит баг, который существовал ДО текущих изменений (не введён этим supervisor'ом):
```bash
bd create "Bug: описание" -d "Найдено при review {BEAD_ID}. Баг существовал до текущих изменений."
```
НЕ блокирует approval текущего review.
