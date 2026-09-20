# Extract Pi workflow — design freeze (z3h0 / 7fz7)

Дата: 2026-09-18. Bead: `beads-task-issue-tracker-7fz7`. Epic: `beads-task-issue-tracker-z3h0`.
HEAD worktree: `docs/7fz7-pi-workflow-extract-design`.

Это карта этапа 1. Не создаёт репозиторий пакета и не вырезает `.pi/` из трекера.

## Пререквизиты пакета (онбординг)

Пакет — **Pi + beads**, не любой трекер задач.

Обязательно: Pi, git, `bd` (в проекте есть `.beads` или `bd init`).
Нет `bd` → doctor **hard fail**, не TODO.

Не цель пакета: GitHub Issues / Linear без beads.

## Онбординг UX (этап 3 / z6dd) — взять у create-beads-orchestration

Источник: глобальный Claude skill `~/.claude/skills/create-beads-orchestration/SKILL.md` (пакет beads-orchestration). Максим 2026-09-18: взять необходимое, не копировать продукт Claude.

Брать в SETUP/doctor пакета:

1. **Detect:** свежий проект vs продолжение (пакет уже в `.pi/settings.json`?). Не ставить второй раз.
2. **Мало вопросов, потом команда** — не «прочитай AGENTS.md». Короче: Pi/git/bd есть? → `pi install -l git:github.com/Maxpceo/pi-workflow@tag`.
3. **Честный стоп на reload:** после install Pi может требовать trust проекта / `/reload`. Сказать человеку перезапустить Pi; иначе «не работает» = ложный баг.
4. **После install — разведка стека, не готовый vue.** Скан package.json / pyproject → overlay: routing + implementer (Python фонд) или vue-supervisor (трекер). Не качать чужих Claude-агентов.
5. **Готово только когда doctor зелёный.** `pi list` недостаточно: bd, implementer, routing.
6. **bd назван зависимостью явно** (уже: нет bd → hard fail).

Не брать: `.claude/`, хуки Claude, `npx beads-orchestration`, Kanban UI, worktree `.worktrees/bd-…`, правило «оркестратор не пишет design».

Скилл пакета (черновик имени): поставить workflow в этот репо. Шаги: detect → install → reload если нужно → doctor → скан/вопрос стека → routing+implementer → doctor зелёный.

## Репорт бага workflow из consumer (скилл в пакете)

Максим 2026-09-18: работая в трекере/sharks, ошибка процесса; вручную заводить bead в pi-workflow легко описать криво. Скилл должен оформить задачу **сразу в bd канона**.

Возможно: да. `bd --db <pi-workflow>/.beads create …` из cwd consumer. Скилл едет в пакете (этап 3 / z6dd), триггеры: «баг pi», «зафиксируй в канон», «workflow сломался».

Это хороший вариант: агент в сессии уже видит команду, exit, логи — человек не обязан помнить формулировку.

Правила скилла:

1. Классифицировать: баг продукта consumer → local `bd create`; баг claim/plan/review/land/policy/extension → канон; сомнение → один вопрос.
2. Собрать evidence в consumer, не чиня пакет: cwd, git HEAD, команда, exit, кусок вывода, ожидалось vs получили, версия пакета / `.pi-workflow.version`.
3. Писать в канон полным шаблоном create-bead, labels `pi`+`workflow`, секция Consumer-repo / Consumer-HEAD.
4. Не claim/dispatch в pi-workflow из этой сессии. Не патчить установленные copies в consumer.
5. Нет локального клона канона → стоп: «нужен clone pi-workflow», не тихий local bead.

Не делать: дублировать баг в оба `.beads`; GitHub Issues вместо bd канона.

## GitHub и диск (зафиксировано Максимом)

| Поле | Значение |
|---|---|
| Локальный путь | `/Users/maksimposudevskiy/Projects/pi-workflow` |
| GitHub | **private** `Maxpceo/pi-workflow` |
| Remote | SSH `git@github.com:Maxpceo/pi-workflow.git` (как трекер) |
| Кто создаёт remote | оркестратор через `gh repo create --private` на **этапе 2**, не здесь |
| Visibility трекера | public — workflow специально **не** копирует это |

Команды:

- Dev (этап 2, **не** cwd трекера): `pi install -l /Users/maksimposudevskiy/Projects/pi-workflow`
- Consumer (этапы 4–5 и README): `pi install -l git:github.com/Maxpceo/pi-workflow@<tag>`
- Bump: `pi install -l git:github.com/Maxpceo/pi-workflow@<new-tag>` (`pi update --extensions` git pin сам не двигает)

В README запрещён путь `/Users/maksimposudevskiy/...`.

## 4zaz

`beads-task-issue-tracker-4zaz` в bd **closed** (реализация в другой сессии). На этом checkout **нет** `.pi/supervisor-routing.json`; `chooseSupervisor` в `beads-dispatch/index.ts` ~L512 ещё hardcode vue/tauri/test.

Extract **не** переписывает routing. После merge 4zaz в main: файл routing = overlay-template + чтение из пакета; агенты vue/tauri/test остаются overlay трекера.

Не плодить второй bead на chooseSupervisor.

## Инварианты cutover (выполнять на этапах 2/4, не здесь)

1. `pi install` этапа 2 только в песочнице или репо пакета. В трекер — только этап 4.
2. Dual-load: Pi auto-discover `.pi/extensions/*/index.ts` **независимо** от массива `settings.json`. `pi list` не доказывает отсутствие копий. Перед smoke: generic files убрать с auto-discover (aside/rename).
3. После копирования в пакет не править tracker `.pi/extensions` (не dual-write).
4. Cutover: один атомарный коммит (settings + aside generic + overlay). Rollback = `git revert` этого коммита.
5. Smoke не `workflow_claim` чужого in_progress; throwaway/fixture bead.
6. Этап 5 (sharks) строго после этапа 4.

## Doctor (черновик таблицы)

| Проверка | Нет → |
|---|---|
| Pi | hard fail |
| git | hard fail |
| `bd` / `.beads` | **hard fail** |
| пакет в settings | hard fail |
| `implementer.md` + `supervisor-routing.json` | hard fail (не optional) |
| `domain.md` пустой | TODO |
| locale flag | TODO (трекер: ru) |
| cmux | TODO optional |
| `gh` | TODO optional (нужен merge-to-main) |

TODO печатать текстом, без stack trace.

## Замыкание импортов (package)

Package-файл не импортирует overlay/tracker/delete.

Граф (все эти каталоги — **package**, иначе резать hooks):

- `beads-dispatch` → subagent/dashboard, path-rules, worktree-scope, agent-models
- `beads-policy` → worktree-scope, beads-dispatch/cmux-transport
- `workflow-state` → workflow-intent, worktree-scope
- `plan-mode` → workflow-state, workflow-intent, plan-review, beads-dispatch, review-workflow, worktree-scope
- `review-workflow` → path-rules, subagent/dashboard, worktree-scope, agent-models
- `plan-review` → subagent/dashboard
- `subagent` → agent-models

Вывод: **весь текущий runtime-граф extensions — одна корзина package**, пока нет явного разрыва. Overlay — агенты продукта, domain.md, routing.json, locale, stack-check config, orchestrator copy, куски AGENTS.md.

`footer-dashboard`: есть `index.ts`, **нет** в `settings.json`, но auto-discover его подхватит. В карте: package (или delete, если мёртвый после проверки `registerCommand` без settings — оставить package, чтобы cutover не забыл файл на диске).

`workflow-intent`: не в settings, импортируется — **package**.

## Карта путей

Метки: `package` | `overlay-template` | `tracker` | `delete`

### settings / корень `.pi`

| Путь | Метка |
|---|---|
| `.pi/settings.json` | tracker (после этапа 4: spec пакета `-l`, без local generic paths) |
| `.pi/agent-models.json` | tracker (модели Максима не в пакет) |
| `.pi/prompts/` (пусто) | package convention ok, сейчас пусто |

### Extensions (runtime-граф = package)

| Путь | Метка |
|---|---|
| agent-models/ | package |
| bead-purpose/ | package |
| beads-dispatch/ | package |
| beads-policy/ | package |
| cmux-sidebar/ | package (generic cmux UX; не vue) |
| follow-up-reminder/ | package |
| footer-dashboard/ | package |
| memory-capture/ | package |
| path-rules/ | package |
| plan-mode/ | package |
| plan-review/ | package |
| review-workflow/ | package; **stack-checks вынести в overlay-config до этапа 2** (см. хардкоды) |
| session-context/ | package |
| session-replay/ | package |
| status-dashboard.ts | package |
| subagent/ | package |
| workflow-chain/ | package |
| workflow-intent/ | package |
| workflow-state/ | package |
| worktree-scope/ | package |
| `.gitkeep` | tracker/ignore |

### Skills

| Путь | Метка |
|---|---|
| claim-bead, create-bead, plan-bead, dispatch-supervisor, review-bead, land, merge-to-main, managing-epics, finalize-epic, release, spawn-task-workspace | package; **pnpm/vue-tsc и таблица vue/tauri в тексте — overlay-config / 4zaz, вычистить из generic до этапа 2** |
| pi-extension | tracker (ловушки vitest/pi-tui этого репо) |

### Agents

| Путь | Метка |
|---|---|
| detective, architect, code-reviewer, documentation-expert, plan-*-reviewer | overlay-template (Pi package не бандлит agents; копировать SETUP) |
| implementer.md | overlay-template **создать** (сейчас нет файла) |
| vue-supervisor, tauri-supervisor, test-supervisor | tracker overlay |
| agents/README.md | split: generic contract → package docs; таблица vue/tauri → tracker |

### Rules / AGENTS / orchestrator / plans / tests

| Путь | Метка |
|---|---|
| `.pi/rules/domain.md` | tracker overlay |
| `.pi/rules/codebase.md` | split: DRY/naming generic → overlay-template; Vue/pnpm/Tauri → tracker |
| `.pi/rules/README.md` | overlay-template / package docs |
| `AGENTS.md` | split: lifecycle/evidence → overlay-template; merge-slot holder, cmux geometry, labels frontend — tracker+template |
| `.pi/orchestrator/*.sh` | overlay-template (ping path в worktree) |
| `.pi/plans/*` | tracker (история); этот файл остаётся в трекере |
| `tests/extensions/*.test.ts` | package (переезд с кодом); импорты сегодня `../../.pi/extensions` |
| `tests/mocks/pi-tui.ts`, `vitest.config.ts` alias | package test harness |
| `app/`, `src-tauri/` | tracker продукт |

## Хардкоды (паттерн 4zaz)

Не создавать новые beads в этом ходе. Список на утверждение Максима.

| ID | Семья | Где | До этапа 2? | Статус |
|---|---|---|---|---|
| 4zaz | routing агентов | beads-dispatch `chooseSupervisor`; dispatch-supervisor SKILL | да | **closed в bd; кода routing.json на этом main нет** — ждать merge, не дублировать |
| H2 | stack-checks | review-workflow `checksForFiles` vue-tsc/pnpm; land/merge-to-main/release SKILL `pnpm test && npx vue-tsc`; plan-bead/create-bead allowlist | да | нужна задача как 4zaz: project verification config |
| H3 | locale | beads-policy `enforceBeadRussianLocale`; create-bead | да | флаг overlay; пакет default off; трекер ru |
| H4 | labels в skills | create-bead «frontend, backend» как примеры | можно с H3 | docs overlay |
| H5 | default agent | chooseSupervisor else `test-supervisor` | закрывается 4zaz | overlay routing default; generic fallback `implementer` |
| H6 | agent-models defaults | agent-models/index.ts ключи vue-supervisor/tauri-supervisor | после 4zaz | сканировать `.pi/agents/*.md`, не хардкод имён |

`domain.md` / vue-агенты — overlay, не JSON-конфиг.

## Слайсинг этапов (v2)

1. **7fz7 (этот файл)** — карта + аудит.
2. **b18h** — репо + copy package-меток + vitest + **private** GitHub + tag. Acceptance: `pi list` в песочнице. **Не** «без vue-supervisor».
3. **z6dd** — implementer+routing обязательный SETUP; stack overlay (H2); locale flag (H3); doctor; онбординг UX как в секции выше (detect / install / reload / discovery overlay).
4. **pv7r** — трекер consumer; overlay копирует **текущую** матрицу vue/tauri/test (не только frontend→vue).
5. **ajex** — sharks той же git@tag командой.

Между 2 и 4 трекер пакет не ставит.

## Список конфиг-задач (не созданы)

Ждать ок Максима:

1. Не трогать 4zaz — долить/проверить merge.
2. H2 — verification config (pnpm/vue-tsc не default пакета).
3. H3 — locale flag.
4. H6 — agent-models без зашитых имён (можно вместе с 4zaz, если ещё открыто в коде).

Рекомендуемый порядок до mkdir пакета: merge 4zaz → H2 → H3.

## Out of scope этого файла

mkdir `pi-workflow`, `gh repo create`, вырезание `.pi/`, sharks, реализация H2/H3, закрытие 7fz7 без review.
