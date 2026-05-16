# Pi Rules Architecture — куда класть новое правило

Справочник для orchestrator'а и Pi agents. Читать при запросах вроде: «добавь правило», «запомни ограничение», «куда положить правило», «обнови инструкции агента», «добавь workflow policy».

Цель: не плодить противоречащие источники правды. Для Pi активный источник — `AGENTS.md` плюс `.pi/*`. `CLAUDE.md`, `.claude/*` и `PROJECT-CONTEXT.md` являются reference inputs только для явной parity/migration задачи.

## 1. Быстрый decision tree

| Если новое правило про... | Primary home | Secondary/reference updates | Почему |
|---|---|---|---|
| Как orchestrator ведёт работу: bd lifecycle, evidence, review, landing, permissions, отчёты | `AGENTS.md` | `.pi/skills/*/SKILL.md`, если это конкретная процедура | `AGENTS.md` всегда в контексте Pi-сессии и задаёт process policy. |
| Как писать/проверять код: DRY, naming, no silent fallbacks, структура файлов, TS/Rust/Vue conventions, code docs | `.pi/rules/codebase.md` | Agent-specific note only if one role needs extra emphasis | Этот файл автоматически попадает в `PATH_RULES_LOADED` typed workflows как global codebase rule. |
| Доменные/runtime ограничения проекта: logging domain details, locale sync, frontend review checklist, src-tauri/bd compatibility, sync/data constraints | `.pi/rules/domain.md` | Cross-reference from `.pi/rules/codebase.md`, если это также coding convention | Domain rules нужны всем typed workflow agents вместе с codebase rules. |
| Многошаговая процедура orchestrator'а: claim, plan, dispatch, review, land, release, manage epics | `.pi/skills/<name>/SKILL.md` | Краткая ссылка в `AGENTS.md`, если процедура обязательна globally | Skills активируются у orchestrator'а по description и не должны раздувать always-on context. |
| Инструкция только для одного Pi agent role: `vue-supervisor`, `tauri-supervisor`, `code-reviewer`, `architect`, `detective` | `.pi/agents/<agent>.md` | `.pi/agents/README.md`, если меняется общий agent contract | Agent body получает только соответствующий subagent; shared rules не дублируем в каждом agent. |
| Runtime enforcement / tool behavior / prompt injection / deterministic guard | `.pi/extensions/<extension>/` | `.pi/rules/README.md` или extension README для объяснения модели | Extensions исполняют поведение; rules объясняют policy. Не заменять code guard текстовой просьбой. |
| Path-scoped локальные правила рядом с кодом | `AGENTS.md` или `PI_RULES.md` в соответствующей директории | `.pi/rules/codebase.md` только для cross-cutting версии | `path-rules` ищет allowed filenames по ancestor dirs target files. Для Pi не создавать и не менять `CLAUDE.md` без явного запроса. |
| Извлечённый урок, gotcha, предпочтение, feedback из конкретной работы | bd comment with `LEARNED:` / `DECISION:` / `PATTERN:` или dedicated bead | Не писать сразу в global rules без обобщения | Memory/knowledge — для reusable facts; global rule — только после осознанного обобщения. |
| Публичная документация продукта / release notes / README | Project docs (`README.md`, `CHANGELOG.md`, docs/) | `.pi/rules/codebase.md` только если меняется стандарт docs | Public-facing text stays English unless Maxim explicitly requests otherwise. |

## 2. Уточняющие вопросы перед записью правила

1. **Кто должен знать правило всегда?**
   - Все orchestrator sessions → `AGENTS.md`, но держать кратко.
   - Только agents при работе с кодом → `.pi/rules/codebase.md` / `.pi/rules/domain.md`.
   - Только один role agent → `.pi/agents/<agent>.md`.

2. **Это policy или executable guard?**
   - Policy/explanation → rule/docs.
   - Должно блокировать действие или менять tool behavior → `.pi/extensions/*` плюс docs.

3. **Это процедура или ограничение?**
   - Процедура с шагами → `.pi/skills/*/SKILL.md`.
   - Ограничение/конвенция → `.pi/rules/*` или `AGENTS.md`.

4. **Правило cross-cutting или path-local?**
   - Cross-cutting → `.pi/rules/codebase.md` / `.pi/rules/domain.md`.
   - Только поддиректория/тип файлов → локальный allowed rule file (`AGENTS.md` или `PI_RULES.md`) рядом с кодом, если это не конфликтует с Pi source-of-truth.

5. **Не создаём ли дубликат?**
   - Перед добавлением искать по `rg` в `AGENTS.md .pi`.
   - Если правило уже есть, лучше уточнить existing source или добавить cross-reference, чем копировать формулировку в несколько мест.

## 3. Runtime delivery model

Typed workflow tools deliver shared rules automatically:

- `dispatch_supervisor`
- `dispatch_reviewer`
- `dispatch_docs_agent`
- `review_bead`

Они рендерят `PATH_RULES_LOADED` через `.pi/extensions/path-rules/index.ts` и включают global rules:

- `AGENTS.md`
- `.pi/rules/domain.md`
- `.pi/rules/codebase.md`

Также `path-rules` добавляет allowed path-scoped files from ancestor directories for target files.

### Generic `subagent` exception

Generic `subagent` запускает project agents в изолированном контексте, но **не рендерит `PATH_RULES_LOADED` автоматически**.

Если generic `subagent` используется для codebase-sensitive planning/investigation, orchestrator обязан выбрать один из вариантов:

1. предпочесть typed workflow tool, если он есть;
2. явно включить relevant rule context / `PATH_RULES_LOADED` в task prompt;
3. ограничить задачу так, чтобы codebase rules не требовались.

## 4. Анти-паттерны

- Не добавлять Pi workflow changes в `CLAUDE.md` или `.claude/*` без явного запроса Максима.
- Не класть длинный decision tree в `AGENTS.md`; `AGENTS.md` должен указывать на справочник и хранить only always-on policy.
- Не дублировать одно правило одновременно в `AGENTS.md`, `.pi/rules/codebase.md` и agent bodies. Выбрать primary home, в остальных — короткая ссылка при необходимости.
- Не превращать historical plan (`.pi/plans/*`) в active rule source. Plans объясняют происхождение решений, active rules живут в `AGENTS.md` / `.pi/rules/*` / `.pi/skills/*` / `.pi/agents/*`.
- Не записывать единичный случай как global rule без обобщения и acceptance evidence.

## 5. Verification checklist для изменения правил

Перед завершением изменения rule architecture или rule placement подтвердить evidence:

- Primary home выбран по decision tree.
- `rg` проверил, что нет конфликтующего existing rule.
- Если изменён codebase/domain rule, typed workflow delivery всё ещё покрывает его через `PATH_RULES_LOADED`.
- Если затронут generic `subagent`, явно описано, кто inject'ит rules.
- `.claude/*` и `CLAUDE.md` не изменены без явного запроса.
- bd содержит acceptance evidence для rule/documentation change.
