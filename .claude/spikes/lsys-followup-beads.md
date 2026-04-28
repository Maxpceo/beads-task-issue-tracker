# Spike beads-task-issue-tracker-lsys: автоматическое заведение «упомянутых, но не созданных» bead'ов

> Spike-исследование. Не production-код. Реализация рекомендации — отдельный follow-up bead.

## 1. Problem statement

В `reviewing-code` workflow разные агенты регулярно говорят «это стоит починить отдельной задачей» — bead **никто не заводит**. Пользователь напоминает вручную, контекст уходит между сессиями.

**Свежий пример** (bd-606r): reuse-агент `simplify` нашёл 14+ повторов deferred-promise boilerplate в тестах, явно пометил «follow-up bead — pattern уже 14+ раз в проекте». Bead заведён только после прямого напоминания пользователя — отдельным коммитом спустя время.

**Класс проблемы шире, чем `simplify`:**

| Класс | Источник | Пример фраз |
|-------|----------|-------------|
| Simplify follow-ups | reuse / quality / efficiency агенты | `follow-up bead`, `отдельным bead`, `scope-cut`, `вне scope`, `out of scope`, `not worth fixing now` |
| Pre-existing bugs | code-reviewer | `pre-existing`, `существовал до`, `баг не введён этим`, `не блокирует approval` |
| Review side-findings | code-reviewer этап 2 | `найден баг … не блокирует`, `стоит вынести в отдельный bead`, `нужно завести задачу` |
| RAMS / WIG side issues | RAMS, web-interface-guidelines | `non-critical follow-up`, `можно отложить`, `улучшение не блокирующее` |
| Acceptance deferrals | orchestrator | `отложим в follow-up`, `починим отдельным bead` |

**Тождественное доказательство неэффективности голого precedent'а.** В `.claude/skills/reviewing-code/SKILL.md:202-210` уже есть правило:

```text
## Pre-existing bugs

Если ревьювер находит баг, который существовал ДО текущих изменений (не введён
этим supervisor'ом):

  bd create "Bug: описание" -d "Найдено при review {BEAD_ID}. Баг существовал
  до текущих изменений."

НЕ блокирует approval текущего review.
```

Правило написано — orchestrator его игнорирует. Значит **просто скопировать «новое правило в конец документа» — заведомо не сработает**. Формулировка нового правила должна явно адресовать причины игнорирования (раздел 6 ниже).

## 2. Constraints (из bead description + уточнения пользователя)

Отсекают часть space решений:

1. **`simplify` — built-in Claude Code skill.** Локальный SKILL.md не существует (`find ~/.claude -path '*simplify*'` пусто). Вызывается из `.claude/skills/reviewing-code/SKILL.md:30` через `Skill(skill="simplify")`. Prompt трёх general-purpose агентов (reuse / quality / efficiency) **не контролируем**. Все рычаги — на уровне wrapper'а.

2. **Никаких вопросов посреди workflow.** Прямое требование пользователя. AskUserQuestion после каждого step'а — отвергнут.

3. **Один вопрос в самом конце**, перед `bd close`, **только при сомнениях**. Если сомнений нет — bead'ы заводятся молча, потом одно сообщение в финальном отчёте.

4. **Сначала пробуем чистое правило**, без хуков. Гипотеза: если правило стоит на правильном месте в workflow и сформулировано императивом — orchestrator его исполнит. Hook — отложенная страховка, не основное решение.

5. **CLAUDE.md «Workflow Execution Style»** разрешает остановки только на «реальных точках решения вне плана» (scope vs follow-up — именно эта категория). Финальный batch-вопрос «N findings под вопросом — завести / объединить / отбросить» — формально допустим.

## 3. Approaches comparison

| # | Подход | Прерывает workflow? | Доверие правилу | Реализуемость | Вердикт |
|---|--------|---------------------|-----------------|---------------|---------|
| 1 | Расширить prompt `simplify`-skill | — | — | ✗ built-in, нет доступа | DROP |
| 2 | PostToolUse hook на `Skill` | нет | — | ✗ matcher `Skill` не зарегистрирован в `.claude/settings.json`; supported только `Task` и `Bash` | DROP |
| 3 | AskUserQuestion после каждого step | **да** | — | возможно технически | DROP — пользователь явно против |
| 4 | Stop / SubagentStop reminder-hook | нет | низкое (precedent с `remind-pre-existing.sh` неэффективен) | ✓ | DEFER — страховка после запуска правила |
| 5 | **Wrapper-rule + sweep-step + финальный AskUserQuestion при сомнениях** | нет | **первая попытка проверить** | ✓ | **ВЫБОР** |
| 6 | Hard-block Stop с `decision: "block"` | да (в момент Stop) | — | ✓ | DROP — пользователь явно против прерываний |

**Подход №2 invalidated конкретным фактом** (Explore-проверка): в `settings.json` `PostToolUse` имеет matchers только для `Task` и `Bash`. Skill-level matcher невозможен в текущей конфигурации.

**Подход №3 invalidated требованием №2** (constraints).

**Подход №6 invalidated требованием №2 + потенциально ломает порядок stop-hook'ов** (`Stop` в Claude Code не задумывается для блокирования с условной разблокировкой, существующий `validate-completion.sh` SubagentStop работает иначе).

## 4. Recommended approach: №5 — Wrapper-rule + sweep-step

### 4.1. Архитектура

**Trigger.** После каждого review-step (Step 1 simplify, Step 2 code-review, Step 2.5 RAMS/WIG, Step 3 acceptance) orchestrator выполняет inline-инструкцию: пройтись по summary текущего step'а, выписать findings с маркерами из таблицы (раздел 1).

**Аккумуляция.** Findings копятся в локальный список `FOLLOWUPS` orchestrator'а (его рабочий контекст, не на диск). Поля записи:

- `source-step` (например, `simplify`, `code-review`, `RAMS`, `acceptance`).
- `title` (вытащенный или сформулированный из контекста finding'а).
- `rationale` (1-2 строки, *почему* отдельный bead, не текущий).
- `suggested-label` (выводится из домена step'а: simplify → `dx`, RAMS → `ui`, code-reviewer → label текущего bead'а, acceptance → label текущего bead'а).
- `suggested-type` (`bug` для pre-existing / RAMS critical, `task` иначе).
- `confidence` (`certain` / `uncertain`).

**Sweep.** Перед Step 4 (close) — новый Step 3.5:

1. Каждый `confidence=certain` finding → `SKIP_ENRICH_CHECK=1 bd create --title "Follow-up из {source-step} {BEAD_ID}: {title}" -d "{rationale}" --label {suggested-label} --type {suggested-type}` молча.
2. Каждый `confidence=uncertain` → откладывается в локальный список `QUESTIONS`.
3. Сводка в comment текущего bead'а: `bd comments add {BEAD_ID} "FOLLOWUPS: создал N bead'ов: [список ID]. Сомнений: M."`

**Финальный момент решения.** Перед `bd close`, если `QUESTIONS` непуст — **один** AskUserQuestion с batch-форматом: «N findings под вопросом, как поступить с каждым: [завести как отдельный / объединить с X / отбросить]». Это единственный вопрос за весь workflow и приходится строго на «scope vs follow-up» — категория, разрешённая в CLAUDE.md.

**Финальный отчёт workflow-skill'а** (per CLAUDE.md execution style §2 — markdown-таблица):

- Секция «Follow-up bead'ы» — список созданных bead-ID + title.
- Секция «Сомнения» — `M` (или 0).

### 4.2. Pseudo-patch к `.claude/skills/reviewing-code/SKILL.md`

Не commit'ить — показано как контракт нового правила.

**Новая секция вставляется после строки 16 «Execution style» (выше Step 1) — критично для priming'а до того, как orchestrator начнёт читать шаги:**

```markdown
## Universal sweep — упомянутые, но не созданные bead'ы

Каждый review-step (1 simplify, 2 code-review, 2.5 RAMS/WIG, 3 acceptance) ОБЯЗАН после получения summary от skill'а / агента:

1. Найти в summary findings с маркерами:
   - simplify: "follow-up bead", "отдельным bead", "scope-cut", "вне scope", "out of scope", "not worth fixing now"
   - code-reviewer: "pre-existing", "существовал до", "баг не введён этим", "не блокирует approval"
   - RAMS / WIG: "non-critical follow-up", "можно отложить", "улучшение не блокирующее"
   - orchestrator: "отложим в follow-up", "починим отдельным bead"

2. Каждый match — запись в локальный FOLLOWUPS-список с полями: source-step, title, rationale, suggested-label, suggested-type, confidence (certain | uncertain).

3. Workflow НЕ прерывается. Идём к следующему step'у.

Список фраз — не закрытый. Если orchestrator видит явное намерение «нужно отдельной задачей» в иной формулировке — добавляет finding в FOLLOWUPS и предлагает дописать фразу в этот список (в финальном отчёте).
```

**Новая секция Step 3.5, между текущей Step 3 (Acceptance, ~line 164) и Step 4 (Close, ~line 186):**

```markdown
## Step 3.5: Sweep follow-ups (перед Step 4)

Если FOLLOWUPS непуст:

1. Для каждой записи с confidence=certain:
   SKIP_ENRICH_CHECK=1 bd create --title "Follow-up из {source-step} {BEAD_ID}: {title}" -d "{rationale}" --label {suggested-label} --type {suggested-type}
   Молча. Сохраняй полученный ID.

2. Записи с confidence=uncertain — в локальный QUESTIONS-список.

3. bd comments add {BEAD_ID} "FOLLOWUPS: создал N bead'ов: [ID1, ID2, ...]. Сомнений: M."

В финальный отчёт workflow добавь секцию:
| Follow-ups | N созданных, M сомнений |
| FOLLOWUP IDs | bd-XXX, bd-YYY |
```

**Обновление Step 4 (Close):**

```markdown
## Step 4: Close

Перед bd close: если QUESTIONS непуст — ОДИН AskUserQuestion с batch-форматом
«N findings под вопросом, как поступить с каждым: [завести / объединить с X /
отбросить]». Это единственный вопрос за весь workflow.

После ответа пользователя — для выбранных «завести» / «объединить» сделать
bd create / bd update, для «отбросить» — bd comments add {BEAD_ID} "DROPPED:
[список с обоснованием]" в исходный bead.

Затем:
  bd close {BEAD_ID} --claim-next
```

**Существующая секция «Pre-existing bugs» (lines 202-210) удаляется** — её содержание полностью покрыто универсальным правилом выше.

### 4.3. Sample interaction (как это выглядит в одной сессии)

Сжатый пример того, как orchestrator проходит cycle с тремя findings (упрощено):

```text
[Step 1: Skill(simplify) returns]
  Summary: "...reuse-агент: 14 occurrences deferred-promise boilerplate -
  follow-up bead. quality-агент: function naming inconsistency, scope-cut. ..."

[Universal sweep — после Step 1]
  FOLLOWUPS:
    {source: simplify, title: "Извлечь makeDeferred() helper", rationale: "14
     occurrences", label: dx, type: task, confidence: certain}
    {source: simplify, title: "Унификация function naming", rationale:
     "scope-cut, не в этом PR", label: dx, type: task, confidence: certain}

[Step 2: code-review APPROVED, без findings]
[Step 2.5: RAMS 92/100, WIG OK, без findings]
[Step 3: Acceptance PASSED]

[Step 3.5: sweep]
  bd create -> bd-AAA
  bd create -> bd-BBB
  bd comments add: "FOLLOWUPS: создал 2 bead'ов: [bd-AAA, bd-BBB]. Сомнений: 0."

[Step 4: Close — без вопроса (QUESTIONS пуст)]
  bd close ... --claim-next

[Финальный отчёт]
  | Follow-ups | 2 созданы |
  | IDs | bd-AAA, bd-BBB |
```

С `confidence=uncertain` (например: «3 похожих finding'а — объединить в один bead или развести?») итоговый вопрос приходит **один раз**, перед close.

## 5. Защита от Detective-находок

Detective-ревью одобренного плана выявил 13 проблем (3 critical / 5 major / 4 minor / 1 закрыт). Подход №5 закрывает их следующим образом:

| # | Detective-критика | Как закрыто в подходе №5 |
|---|-------------------|--------------------------|
| 1 | «built-in доказан косвенно» | Закрыто: invocation-site `Skill(skill="simplify")` в `reviewing-code/SKILL.md:30` (см. раздел 2). |
| 2 | Stop vs SubagentStop план не различает | Не релевантно — подход №5 не использует hooks. Hook-вариант (раздел 7) явно использует `SubagentStop`. |
| 3 | Soft-reminder неэффективен (precedent doc) | Подход №5 НЕ полагается на soft-reminder. Полагается на императивную inline-инструкцию + position-in-workflow. См. раздел 6. |
| 4 | N findings → 1 bd create в hook-pattern | Не релевантно — orchestrator проходит по списку явно, не зависит от счётчика hook'а. Каждый finding обрабатывается отдельно. |
| 5 | False-positive: маркеры в самом плане | Не релевантно — подход №5 не парсит transcript. Orchestrator смотрит только summary текущего step'а в своём контексте. |
| 6 | Cross-session false-positive | Не релевантно — FOLLOWUPS список локальный для одного review-cycle, обнуляется в новом. |
| 7 | Supervisor-subagent vs orchestrator transcript | Не релевантно — все review-step'ы выполняются orchestrator'ом. |
| 8 | Два источника, один regex-pass | Не релевантно — каждый step добавляет в FOLLOWUPS отдельно с указанием source-step. |
| 9 | Упущена альтернатива batch AskUserQuestion | Учтено — финальный AskUserQuestion перед close, batch-формат, один за весь workflow. |
| 10 | `SKIP_ENRICH_CHECK=1` деградирует дисциплину | Принято осознанно: для follow-up stub'ов это документированный override (`workflow-templates.md` §1, `enforce-bead-enrichment.sh:25` поддерживает явно). Минимальный enrichment — `rationale` поле + источник в title. Полное enrichment добавляется когда bead будет claim'нут. |
| 11 | `.claude/spikes/` создание | Закрыто: директория создана для этого spike'а. Hook-coverage проверена (нет блокирующих хуков на новые `.md` в `.claude/spikes/`). |
| 12 | Судьба `remind-pre-existing.sh` | Решено: тестов нет (`.claude/hooks/tests/` не содержит `pre-existing*`), удалить в той же итерации, что и реализация правила. |
| 13 | N=1 (только bd-606r) — слабая база | Принято: правило дешёво (≤80 строк markdown), risk over-engineering минимален. Метрика успеха в разделе 8 проверит фактическую частоту. |

## 6. Почему новое правило может сработать там, где precedent с pre-existing bugs не сработал

Текущий precedent (`reviewing-code/SKILL.md:202-210`) проваливается по 4 причинам — новое правило адресует каждую:

| Причина провала precedent'а | Лекарство в новом правиле |
|------------------------------|---------------------------|
| Сидит **в самом конце** документа, под Skip conditions — orchestrator до него не доходит / context уже забит | Inline в каждом Step + новая секция «Universal sweep» **в начале** (после Execution style, до Step 1). Position-priming. |
| Сформулирован как **условный** («если ревьювер находит…») — нет триггера на каждом step'е | **Императив**: «после получения summary ОБЯЗАН найти findings с маркерами …». На каждом step. |
| Нет конкретных фраз-триггеров — orchestrator не знает что искать | **Закрытый стартовый список** маркеров + явное «список не закрытый, добавь свою фразу» |
| Нет sweep-этапа — каждый step «забывает» свои findings | Новый **Step 3.5: Sweep** с явной аккумуляцией FOLLOWUPS через cycle. |

Дополнительно: новое правило **видимо в финальном отчёте** workflow-skill'а («Follow-ups: N создан»). Это превращает «не сделал» в **наблюдаемый промах** — пользователь сразу видит «0 follow-up'ов» в отчёте и может вернуть orchestrator'а назад. Для precedent'а такой visibility-механики нет.

## 7. Откладываемая страховка-hook (если правило не приживётся через 5 cycles)

Если метрика (раздел 8) ниже 80% — добавляем hook-страховку. Контракт hook'а с учётом всех Detective-критиков:

- **Event:** `SubagentStop` (срабатывает после каждого `Task(...)`), не `Stop` (тот фаерится в конце сессии — слишком поздно).
- **Allow-list:** реагируем только на `subagent_type ∈ {code-simplifier:code-simplifier, code-reviewer, pr-review-toolkit:silent-failure-hunter, ...}`. Прочие subagent'ы пропускаем.
- **Парсинг transcript:** не raw `grep`, а `jq`-проход по записям с `tool_use_id` текущего subagent'а — изоляция от остального transcript'а (закрывает Detective №5, №7).
- **Session-window:** считать markers и `bd create` **с момента начала текущего review-cycle** (по timestamp последнего `Skill("reviewing-code")` invocation). Закрывает Detective №6.
- **Дельта**: вычислять `N markers - N bd create` (не «есть/нет»). Если delta > 0 — реминдер. Закрывает Detective №4.
- **Per-source разбивка:** `jq` группирует findings по `source-step` (simplify / code-reviewer / RAMS / acceptance), реминдер показывает разбивку. Закрывает Detective №8.
- **Decision:** soft-reminder (`<system-reminder>`), не block — иначе прерываем workflow (нарушает требование пользователя).
- **Удаление `remind-pre-existing.sh`** одновременно с релизом нового hook'а (его маркеры — подмножество, тестов нет — Explore №5).

Размер: ожидаемо ~120-150 строк bash вместо ≤ 50 строк голой копии `remind-pre-existing.sh`. Это цена закрытия 5 Detective-критиков.

## 8. Метрика успеха правила

В течение **5 ближайших review-cycles** (после реализации правила) считать вручную:

- `N_mentioned` — сколько findings с маркерами действительно были в summary всех step'ов.
- `N_created` — сколько follow-up bead'ов orchestrator реально завёл (через FOLLOWUPS sweep + финальный AskUserQuestion).

Метрика: `coverage = N_created / N_mentioned`.

- `coverage ≥ 80%` → правило живёт без хука. Закрываем эту линию работы.
- `coverage < 80%` → активируем hook (раздел 7) как страховку.

Учёт ведётся в bead'е реализации правила (`bd comments add` после каждого review-cycle).

## 9. Решение по `remind-pre-existing.sh`

**Удалить** в той же итерации, что и реализация нового правила (отдельный bead). Обоснование:

- Тестов нет (`ls .claude/hooks/tests/` не содержит `*pre-existing*`).
- Маркеры покрываются новым правилом + откладываемым hook'ом (раздел 7).
- Существующий `remind-pre-existing.sh` — Stop-hook (слишком поздно), узкий regex (только pre-existing, не покрывает 4 других класса).

До реализации правила — **оставить как есть**. Soft, не мешает.

## 10. Out of scope (для самого spike'а и для следующего implementation-bead'а тоже)

- Универсальный «post-skill framework» для произвольных reminder-hook'ов (over-engineering под N=1).
- Миграция YAML-формата `## Follow-ups` от built-in skill'ов (требует upstream-изменений в Claude Code).
- Изменение enrichment-дисциплины для всех bead'ов проекта (отдельная дискуссия).
- Auto-enrichment follow-up stub'ов из контекста finding'а (отдельный bead, после реализации базового правила).

## 11. Next steps

1. **Spike close.** Bead `beads-task-issue-tracker-lsys` → `inreview` → `accepted` → `closed` через стандартный review-chain.
2. **Создать implementation-bead** с заголовком «Реализовать Universal sweep follow-up bead'ов в reviewing-code skill'е» (label `dx`, type `task`, priority P3, deps на закрытие lsys).
3. **Implementation-bead делает 4 вещи:**
   - Добавляет новую секцию «Universal sweep» в `.claude/skills/reviewing-code/SKILL.md` после Execution style.
   - Добавляет Step 3.5 между текущим Step 3 и Step 4.
   - Обновляет Step 4 с финальным AskUserQuestion при `QUESTIONS` непустом.
   - Удаляет существующую секцию «Pre-existing bugs» (lines 202-210, перекрыта универсальным правилом).
4. **Через 5 review-cycles после merge** — проверить метрику (раздел 8). Создать optional hook-bead если `coverage < 80%`.
