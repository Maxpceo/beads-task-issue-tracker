# Инструкции для агентов

## Характер проекта

Это трекер задач для workflow AI-агентов. Человек в первую очередь ставит задачи и проверяет результат; агенты создают большую часть содержимого issues, заметок по реализации, evidence для приёмки и handoff-контекста.

Относись к bd issues как к долговечным handoff-пакетам для будущих агентов. Заголовки, описания, комментарии, планы и acceptance evidence должны быть достаточно самодостаточными, чтобы продолжить работу без истории чата.

## Pi-native Workflow

Для Pi-сессий source of truth — этот файл `AGENTS.md` плюс `.pi/*`.

План миграции Pi workflow: `.pi/plans/pi-native-workflow-migration.md`.
Pi-планы и design notes хранятся в `.pi/plans/` или bd.
Архитектура Pi rules / где размещать новые rules: `.pi/rules/README.md`.
Доменные Pi rules для logging, locale sync, UI constraints, frontend review и совместимости src-tauri/bd: `.pi/rules/domain.md`.
Контракты Pi agents, reporting vocabulary и model guidance: `.pi/agents/README.md`.
Прогресс отслеживается в bd, а не markdown task lists.

## Именование Pi-веток и worktree

Канонический формат именования Pi task branch: `<type>/<bead-suffix>-<domain-or-component>-<purpose>`. `type` сопоставляет тип работы с `feat` для feature work, `fix` для bugs, `docs` для docs-only changes, `test` для tests/benchmarks, `ci` для CI automation, `refactor` для refactors, `task` для workflow/general tasks и `chore` для maintenance. `bead-suffix` — короткий суффикс после последнего дефиса в bd id (`beads-task-issue-tracker-lgok` → `lgok`), а не полный project bead id.

Канонический формат имени директории Pi worktree — суффикс ветки без `<type>/`; он должен точно совпадать с branch suffix: ветка `task/lgok-branch-worktree-naming` использует worktree basename `lgok-branch-worktree-naming`. Worktree basenames должны быть lowercase, filesystem-safe и достаточно описательными, чтобы понять задачу без открытия bd.

Хорошие примеры: `feat/lgok-frontend-filtering`, `fix/lgok-sync-status`, `docs/lgok-workflow-contract`, `refactor/lgok-policy-parser`, `test/lgok-policy-coverage`, `chore/lgok-dependency-maintenance`, `ci/lgok-vitest-workflow`, `task/lgok-branch-worktree-naming`. Плохие примеры: `task/lgok` (не хватает domain/purpose), `task/beads-task-issue-tracker-lgok-branch-worktree-naming` (полный bead id), `task/work` (неописательно), worktree basename `other-name` для ветки `task/lgok-branch-worktree-naming` (suffix mismatch).

Это enforced через targeted validation `.pi/extensions/beads-policy` при создании новых task-like worktrees под корнем project worktree: ветки `feat|fix|docs|refactor|test|chore|ci|task` должны использовать canonical branch suffix и matching worktree basename. List/remove/prune/info и non-task smoke/orphan worktrees без task-like branch prefix не подпадают под это naming enforcement.

## Evidence Before Claims (железное правило)

Completion reports и status claims должны подкрепляться fresh evidence в том же сообщении. Не пиши hedging claims вроде “should work”, “probably”, “seems”, “looks correct”, “выглядит корректно”, “должно работать”, “наверное” или “вроде проходит”.

- Claims о том, что tests/builds/checks проходят, требуют command, exit code и relevant output excerpt.
- Claims о том, что bug исправлен или acceptance выполнен, требуют exact command/manual check и observed result.
- Перед закрытием non-trivial bead/epic с acceptance criteria запиши bd comment `ACCEPTANCE MATRIX:`, который сопоставляет каждый acceptance/verification bullet с evidence, exit code или observed result и `PASS|FAIL|NOT RUN|N/A`.
- Не закрывай, если matrix содержит `FAIL`, `NOT RUN`, `BLOCKED` или `SCOPE GAP`, если только Максим не предоставил `HUMAN ACCEPTANCE OVERRIDE` с `approver:` и `reason:`.
- Предотвращай retry loops: после двух падений одного и того же acceptance criterion, после двух acceptance-fix cycles total или когда acceptance blocked/not runnable без понятного local fix, остановись с кратким delta report и попроси Максима принять решение вместо silent redispatch.
- Если command не запускалась, скажи это явно; не подразумевай, что она прошла.
- Celebratory wording допустим только после evidence, никогда вместо evidence.

## Proactive Best-Practice Suggestions

Когда работаешь над feature или fix и замечаешь nearby best-practice improvement с понятным impact, предложи его перед завершением задачи. Не реализуй без подтверждения и не расширяй scope silently.

Используй формат: `Заметил: <что>. Почему: <best practice / concrete impact>. Делать сейчас / отдельным bead / пропустить?`

Хорошие кандидаты: accessibility labels/tooltips для icon-only controls, confirmation для destructive actions, loading/empty states, focus management, form validation, debounced search/filter inputs, persistence filters в URL/localStorage, вынос pure logic в `app/utils/` с tests, удаление duplication, stronger types вместо `any`, замена hardcoded UI strings на `$t(...)`.

Не поднимай style-only или naming-only preferences, если у них нет понятного impact на maintainability, accessibility, correctness или user impact. Не заваливай пользователя minor suggestions.

## Workflow Friction / Improvement Capture

Во время workflow execution (`claim`, `plan`, `dispatch`, `review`, `land`, `merge-to-main`, `release`) активно отслеживай workflow friction, указывающий на то, что process contract можно улучшить. Примеры:

- raw third-party stderr/warnings показаны Максиму вместо actionable workflow message на русском;
- repeated manual recovery steps, которые должны быть documented preflight или typed tool behavior;
- policy blocks, показывающие missing earlier guard или unclear instruction;
- mismatches между skill docs, policy behavior, typed tools и actual command behavior;
- stale/foreign/ambiguous worktree или session-state situations, которые workflow не предотвратил;
- места, где command sequence пришлось manually corrected during execution.

Если friction блокирует текущий workflow, остановись с blocker report и concrete next action. Если он не блокирует текущий workflow, не расширяй scope silently; после стабилизации текущего шага предложи это в формате:

`Заметил: <что>. Почему: <workflow impact>. Делать сейчас / отдельным bead / пропустить?`

Когда Максим выбирает follow-up, создай self-contained bd issue с relevant evidence, labels, dependencies и out-of-scope boundaries. Сохраняй technical command names, file paths, statuses, labels и identifiers без изменений; user-facing explanations должны быть на русском.

## Workflow Execution Style

Для workflow/task execution проходи approved steps без intermediate permission prompts. Не спрашивай “continue?”, “run review?”, “push now?” и подобное, когда next step уже является частью approved workflow.

Останавливайся и спрашивай или сообщай status только в real decision points, где требуется внимание пользователя:

- code review возвращает `NOT APPROVED`;
- acceptance checks fail;
- fix требует expanding scope или creating follow-up work, который явно не входит в scope;
- workflow state stale/foreign/ambiguous и takeover не explicit;
- требуется unapproved destructive/hard-to-reverse action.

Выводы в чат (для Максима):

Пиши обычный markdown. Секции, которые надо заметить — `## …`. Не копируй бланк в ` ```text `.

Автоход по approved workflow — без отчёта и без дубля footer (`plan`, `bdStatus`, branch, worktree, merge-slot). Упоминай footer только если значение anomalous, stale/foreign/ambiguous или safety-relevant.

Стоп или финал:
1. `##` что случилось + название задачи + (`id`).
2. Текст. Словарик проекта не объяснять заново: сессия, bead, claim, смоук-тест, супервизор, code-reviewer, land, merge, cmux-sidebar, пилюля, inreview, PI WORKFLOW UPDATE.
   Имя из кода и английский жаргон этой задачи оставить и сразу расшифровать (что это и что видно). Не заменять русским синонимом. Пример: `MODE_VISUAL` — список стадий, при которых сайдбар рисует пилюлю. То же для leftover, last-writer, no-op, `clear`.
   Скобки с agent-id только если роль и имя разные: супервизор тестов (`test-supervisor`).
3. `## Проверка` — только реально гонявшиеся тесты (тип + файлы + passed/exit). Не писать, чего не гоняли.
4. `## Файлы` — если менялись.
5. Если нужен Максим или create follow-up при живом родителе: отдельно `## Дальше` + `1/2/3`. Create не конец ответа.

В чат не вываливать: `complete_visible_dispatch`, `surface:…`, spawn-ack, ACCEPTANCE MATRIX, `rg` / `git diff --check` как строки отчёта, «Действие Максима: не требуется».

Если говоришь «тесты прошли» — в `## Проверка` есть файл и exit. Это не замена заголовка. Normal Q&A этот формат не требует.

После side-quest (create, docs, вопрос посередине) сразу вернуться к active non-terminal bead.

Короткая recovery при автоходе — одна строка:

```text
Recovery: `gh pr merge` returned exit 1 after a local worktree checkout conflict, but PR #176 is merged and `ecc2ad8` is ancestor of `origin/main`; continuing cleanup.
```

Для long-running или noisy commands (`pnpm test`, `npx vue-tsc --noEmit`, `cargo check`, `git push` hooks) по возможности filter output через `tail -N`/targeted grep. Preserve exit code и important failure/success excerpt; не выгружай thousands of lines в context.

Stage and commit только explicit file paths. Не stage whole trees через dot/all shortcuts.

bd status — lifecycle authority для beads. Pi `workflow-state` — только session-local context: active bead binding, branch/worktree/start/end commit, `sessionMode`, plan mode/approval и merge-slot hint. Agents используют typed workflow tools как primary path: `workflow_status`, `workflow_claim`, `workflow_reset`, `workflow_update`, `workflow_plan_mode`, `workflow_plan_approved` и `workflow_complete`, когда нужен local terminal cleanup. Slash commands вроде `/workflow-status`, `/workflow-claim`, `/workflow-reset`, `/workflow-update`, `/plan` и `/plan-auto` — optional human UI shortcuts, а не required agent steps. После каждого mutating workflow tool или blocker дай visible checkpoint с observed state/tool result; не зависай silently. Checkpoint — inline progress marker, а не stop condition: когда next workflow step уже approved или required активным skill, продолжай в том же turn, если нет real decision point/blocker.
Не start, claim, implement или dispatch unrelated work, пока current-session active bead имеет non-terminal bd status; terminal bd statuses — `closed`, `blocked` или explicit `deferred`/handoff с recorded reason. Если bd status — `inreview`, next action — `review-bead` / `review_bead`, а не другая задача. Если active local workflow-state stale, foreign или ambiguous, вызови `workflow_reset` или попроси explicit takeover confirmation. Если reset выполнен, чтобы выполнить explicit user request переключиться с open/terminal/stale bead на named next bead, сразу продолжай claim/planning этого next bead в том же turn. `land` — explicit save/push checkpoint, а `merge-to-main` — explicit session-final PR/merge workflow; ни один из них не является automatic per-task stage.

## Cmux layout and panel names

Visible cmux agent panes must be distinguishable by tab title:

- Orchestrator tab: `оркестратор`
- Agent tabs: `{role} · {bead-suffix}` (example: `test-supervisor · fo5d`, where `bead-suffix` is the last `-` segment of the bead id)

Visible `dispatch_supervisor` / `dispatch_reviewer` (`transport=cmux`) auto-renames after spawn (`cmux tab-action rename`, `--focus false`). Do not rely on manual rename each spawn.

### Layout geometry (orch exclusive left, agents side-by-side right)

Accepted multi-agent geometry (`beads-task-issue-tracker-kgvd`, Maxim HA f8fl; capacity update 2026-09-15 Maxim / `beads-task-issue-tracker-k9j6`):

- **Оркестратор** stays exclusive on the left (~50%). Agent panes never `new-split` from the orch surface when another live agent already exists.
- First visible agent: `new-split right --surface <orch-caller> --focus false`.
- Each next visible agent: `new-split right --surface <first-live-agent> --focus false` so agents pack **side-by-side on the right half**, not as tabs in one pane and not as a third column that squeezes orch. Typical dual case is supervisor + reviewer (~25%+25% of full width); further agents keep splitting inside that right half.
- Anchor selection uses `resolveVisibleSplitAnchor`: live spawned panes for the bead, oldest `createdAt` then `taskId`; respawn excludes self (solo → orch; with peer → peer). Code has **no hard N=2 cap** — every additional spawn reuses right-from-first.
- **Right-half capacity:** dual is live-HA proven (`f8fl`); Maxim accepts **4–6** simultaneous agent panes on the right half as practical. Prefer readable titles (`{role} · {bead-suffix}`); beyond ~6 is operator judgment, not a code block. No tabs/down overflow path is required in this contract.
- kgvd supersedes the older N=2 tabs geometry note (evxj) and the earlier «N>2 not guaranteed» wording.
- Parallel cross-role double-spawn race is out of scope; sequential orch dispatch is assumed.

### Close supervisor pane after terminal bead

After the bead is terminal (`closed` / `blocked` / `deferred` without continuation) **and** no pending-fix reuse is needed, the orchestrator closes **this bead's** live registry panes only:

```text
close_visible_dispatch({ beadId: <ID> })
```

- Uses spawn-ack / `dispatch-registry.json` pane ids → `cmux close-surface --surface <pane>` + registry `tombstone` (not live for followup).
- `NOT APPROVED` / pending-fix: **do not** close — keep the pane and use `followup_visible_dispatch` (`pendingFix: true` skips close).
- Do not sweep foreign/historical panes, HTML boards, or Haasbot surfaces.
- Prefer `--focus false` paths; do not speculative `select-workspace` / `focus-pane` just to find the surface.

## Fast Path / Large Change Discipline

Fast Path разрешён только когда orchestrator явно считает изменение trivial, low-risk и более дешёвым, чем supervisor dispatch.

- Low-risk direct work: до 3 code files и до 80 added lines, с clear acceptance evidence.
- Threshold exceeded: продолжай только с explicit `FAST_PATH_RATIONALE`/written rationale или переключайся на supervisor path.
- Hard supervisor path: workflow/policy/review/merge logic, `.pi/agents`, scripts или cross-domain frontend + backend changes требуют active bead и approved plan/supervisor workflow.
- Mechanical batches разрешены только с explicit mechanical label/reason, narrow scope и review evidence.
- Docs/beads-only maintenance не должен запускать Fast Path blocks, но всё равно требует accurate bd tracking, когда создаёт work.

Этот проект использует **bd** (beads) для issue tracking. Выполни `bd onboard`, чтобы начать.

## Quick Reference

```bash
bd ready              # Найти доступную работу
bd show <id>          # Посмотреть детали issue
bd update <id> --claim --json      # Claim work
bd close <id>         # Закрыть только после review/acceptance evidence
bd dolt status        # Inspect Dolt-backed bead state when needed
bd dolt pull          # Pull bd/Dolt state when needed
bd dolt push          # Push bd/Dolt state when needed
```

Примечание: `bd show <id> --json` возвращает array; используй `jq '.[0]'`. Проверяй форму одного нового `bd --json | jq` перед parallelizing similar commands.

## Landing the Plane

Используй skill `land`, чтобы save/push session work, или `merge-to-main` для PR + merge. Эти skills отвечают за quality gates, bd/Dolt sync, merge-slot, commit, push, cleanup и final evidence. Работа не завершена, пока соответствующий skill не сообщит successful push/merge; останавливайся раньше только из-за real blocker или решения Максима.

## Permissions and Confirmation

Safe/read-only investigation не требует подтверждения: reading files, searching, inspecting git/bd state и запуск non-mutating checks. Mutating workflow steps, которые уже являются частью approved bead plan или explicit skill (`land`, `merge-to-main`, `review-bead`), можно выполнять без intermediate prompts.

Спрашивай перед действиями, которые destructive, hard to reverse или outside approved plan, включая force-push, reset, deleting worktrees/branches with uncommitted work, closing or stealing someone else’s bead, broad scope expansion или modifying protected/secrets files.

Для Pi workflow changes обновляй `AGENTS.md` и `.pi/*`.

`.pi/extensions/beads-policy` и related Pi policy extensions authoritative, когда они блокируют tool call. Не bypass policy blocks, если пользователь явно не approves documented override.

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: Этот проект использует **bd (beads)** для ВСЕГО issue tracking. НЕ используй markdown TODOs, task lists или другие tracking methods.

Bead titles, descriptions, notes, design text, acceptance criteria и comments должны быть написаны на русском для Максима. Сохраняй technical identifiers без изменений: file/function names, commands, labels, statuses, types и API names.

Project-facing open-source text вроде `CHANGELOG.md`, `README.md`, release notes и commit messages должен быть написан на английском, если пользователь явно не попросил иначе.

### Почему bd?

- Dependency-aware: отслеживает blockers и relationships между issues.
- Git-friendly: Dolt-powered version control с native sync.
- Agent-optimized: JSON output, ready work detection, discovered-from links.
- Предотвращает duplicate tracking systems and confusion.

### Self-Contained Beads

Agent-created beads должны быть self-contained handoff packages. Будущая session должна иметь возможность implement или review задачу без истории чата.

Первый `bd create` write = финальный cold-session пакет, а не черновик: всё, что creating session уже знает и что понадобится имплементеру, пишется в description сразу. Вопрос человека «хватит ли контекста?» не должен быть триггером полноты.

Перед любым agent-created `bd create` (new issue, follow-up, discovered bug, split scope или documented work item) загрузи и примени `.pi/skills/create-bead/SKILL.md`. Hand-written `bd create` commands, пропускающие skill checklist, запрещены. Preferred: file-based description — write полный текст в `/tmp/...md`, затем короткий `bd create ... --description "$(cat /absolute/path)"` (guard читает файл; `#` и backticks в теле безопасны). Legacy: inline heredoc внутри `--description` (хрупко с `#` и backticks). Не прячь description в `$VAR`, wrapper scripts, unsafe `$(cat ...)` с pipes/extra commands или repo-path files.

Required description sections для non-epic, non-exempt agent-created beads:

- `### Origin`
- `### Files`
- `### Current state`
- `### Target state`
- `### Investigation findings`
- `### Decisions`
- `### Rejected alternatives`
- `### Dependencies / blockers`
- `### Acceptance criteria`
- `### Verification / acceptance checks`
- `### Out of scope`

Также обязательно:

- Добавь хотя бы один label (`--label`, `--labels` или `-l`).
- По возможности выбирай labels из domain table ниже.
- Добавляй relationships, когда они известны: `parent-child:<epic-id>` для epic children, `discovered-from:<source-id>` для follow-ups и blocker dependencies для required ordering.
- Acceptance и verification должны быть observable bullet checks, а не vague phrases вроде “works”, “done” или “fixed”.
- Если acceptance unclear, остановись и задай пользователю one concrete question с 2-4 options перед creating, dispatching или closing bead.
- Если context insufficient, сначала investigate, create an investigation bead или ask; не создавай stub tasks, которые зависят от chat memory.

### Domain labels

При создании beads всегда добавляй 1-2 relevant labels:

| Label | Когда использовать | Files / domains |
|---|---|---|
| `frontend` | Vue components, composables, pages | `app/components/`, `app/composables/`, `app/pages/` |
| `backend` | Rust code, Tauri commands | `src-tauri/src/` |
| `tracker` | Built-in tracker engine | `src-tauri/src/tracker/` |
| `ui` | Visual components, shadcn, themes, CSS | `app/components/ui/`, themes, styles |
| `ci` | GitHub Actions, automation | `.github/workflows/` |
| `dx` | Dev tools, tests, configs, docs | `tests/`, config files, docs, agent workflow files |
| `sync` | Sync, Dolt, polling, watcher | `useAdaptivePolling`, `useChangeDetection`, `useSyncStatus`, sync Rust code |
| `data` | Filtering, sorting, CRUD, bd API | `bd-api.ts`, `issue-helpers.ts`, `useIssues`, `useFilters` |
| `pi` | Pi workflow, skills, agents, extensions | `.pi/`, `AGENTS.md` |
| `workflow` | Lifecycle/review/merge/release policy | `.pi/skills/`, `.pi/extensions/`, workflow docs |

### `bd todo` vs full beads

Используй `bd todo` только для tiny, local reminders, когда всё перечисленное верно:

- change меньше ~5 lines и обычно в одном file;
- supervisor/review chain не нужен;
- self-contained handoff package не нужен;
- потеря rich context не повредит будущей session.

Используй `bd create` с full self-contained template для bugs, features, multi-file work, cross-domain work, всего, что требует review, или всего, что другой agent может подхватить позже.

`bd todo` shortcuts — обычные task issues:

```bash
bd todo add "Tiny follow-up"
bd todo list
bd todo done <id>
```

### Quick Start

**Проверить ready work:**

```bash
bd ready --json
```

**Создать новые issues:**

```bash
# Preferred: file-based (write tool → /tmp, then tight cat)
bd create "Добавить проверку формата задач" -t bug|feature|task -p 0-4 --label dx \
  --description "$(cat /tmp/bead-desc-format-check.md)" --json

bd create "Уточнить обработку найденной проблемы" -p 1 --label dx --deps discovered-from:bd-123 \
  --description "$(cat /tmp/bead-desc-followup.md)" --json

# Legacy (fragile with # / backticks in body): inline heredoc
# bd create "..." --description "$(cat <<'EOF'
# ### Origin
# - ...
# EOF
# )" --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Выполнено" --json
```

### Issue Types

Текущий `bd create --type` поддерживает:

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)
- `decision` - ADR/design decision record

Legacy bd type references могут упоминать `spike`, `story` и `milestone`. Не используй их как `--type`, если current bd custom type config их не поддерживает. До тех пор моделируй их так:

- spike/research → `task` с `dx`, `backend`, `frontend` или relevant domain labels и explicit investigation acceptance;
- story → `feature` с user-facing acceptance criteria;
- milestone → `epic` или `decision`/documentation bead, в зависимости от того, содержит ли он work.

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` показывает unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: implement, test, document
4. **Discover new work?** Создай linked issue:
   - `bd create "Описать найденную проблему" --description="Кратко: что обнаружено, где воспроизводится, какой ожидаемый результат" -p 1 --label dx --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Выполнено"`

### bd 0.57+ Dolt sync

bd 0.57+ использует self-managing Dolt server с auto-flush/auto-import. Старой команды `bd sync` больше нет.

- Каждая write operation auto-commits to Dolt history.
- Используй `bd dolt pull` / `bd dolt push` для remote Dolt sync when needed.
- Для legacy JSONL projects явно commit named `.beads/` paths вместо reliance on Dolt commands.
- Manual `bd sync` step не требуется и недоступен.

<!-- END BEADS INTEGRATION -->
