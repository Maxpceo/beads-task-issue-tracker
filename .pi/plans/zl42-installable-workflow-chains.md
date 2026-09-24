# Цепочки ставимого Pi workflow

Задача: `beads-task-issue-tracker-zs2y`. Эпик: `beads-task-issue-tracker-zl42`.

Снято с кода worktree `zs2y-installable-workflow-chains`, ветка `docs/zs2y-installable-workflow-chains`, start `ae2a5c150789236e4591061e68ca5b74b9fbf298`. Удалённый эпик и удалённый файл спеки не источник фактов. `packages.md` в этом репозитории нет, строку оттуда не цитировать.

## Что этот файл решает

Охрана и skills этого репозитория требуют ритуал трекера: отдельная копия на задачу, жёсткий корень копий, сдача через копию. Это не модель для каждого проекта Максима.

Отклонённая цель: поставленный workflow повторяет ритуал этого репозитория и отличается только стеком. Так ставить нельзя.

Нужен один файл проекта. Каждое звено цепочки читает его и решает, требовать ли копию. Установщик этот файл только записывает, после вопросов человеку. Установщик не редактирует `beads-policy` и не разбирает цепочки. Это следствие, не план установки. Выбор `pi install`, doctor и состава пакета здесь не делается.

Детей эпика из этой спеки не заводить. Их заводит следующая сессия после того, как Максим примет файл.

## Файл проекта, который должна читать цепочка worktree

Имени файла в коде ещё нет. Пока звенья не читают его, они зашиты в трекер. Поля, без которых цепочку нельзя переключить:

- `copyRequired` — нужна ли отдельная копия до плана. В трекере да.
- `copyRoot` — куда класть копии. Сейчас зашито `~/Projects/worktrees/beads-task-issue-tracker`.
- `naming` — ветка `<type>/<bead-suffix>-<domain-or-component>-<purpose>`, basename копии равен suffix ветки.
- `handoffFromCopy` — сдача `land` / `merge-to-main` и отчёт «Не в main» идут из копии, пока lock жив. В трекере да.

Пока поле не прочитано звеном, звено остаётся ритуалом трекера. Установщик не подменяет это правкой охраны.

## Цепочка worktree

Звено без пути ниже не писалось. Команда поиска по правилам: `rg -n worktree .pi/rules` — совпадений нет (`README.md`, `codebase.md`, `domain.md`). Правила worktree не требуют.

### 1. Корень копий зашит в охрану

Путь: `.pi/extensions/beads-policy/index.ts:92`

```text
const WORKTREE_ROOT = path.join(os.homedir(), "Projects", "worktrees", "beads-task-issue-tracker");
```

Требует: новые копии только внутри этого каталога. `invalidWorktreePath` (строки 2545–2556) блокирует `bd worktree create` и `git worktree add`, если путь не абсолютный под `WORKTREE_ROOT`.

Читать из файла проекта: `copyRoot`. Пока не читает.

### 2. Имя ветки и basename копии

Путь: `.pi/extensions/beads-policy/index.ts:2559` функция `worktreeNamingBlockReason`.

Требует для префиксов `feat|fix|docs|refactor|test|chore|ci|task`, если путь уже внутри `WORKTREE_ROOT`:

- basename копии точно равен suffix ветки (строка 2571);
- suffix не начинается с полного id проекта (строка 2572);
- suffix вида `<bead-suffix>-<domain>-<purpose>` (строка 2573);
- suffix начинается с короткого суффикса активного bead (строки 2574–2576).

Тот же контракт словами: `AGENTS.md:20–28`.

Читать из файла проекта: `naming`. Пока не читает. Текст `AGENTS.md` установщик тоже не правит.

### 3. Lock: правки и сдача не из main

Путь: `.pi/extensions/beads-policy/index.ts:768–778` `hasActiveWorktreeLockRequirement` / `hasActiveWorktreeLock`.

Требует, пока bead не terminal и есть ownership плюс записанный `worktreePath` или branch:

- `activeWorktreeCwdDecision` (строки 800–863): mutating bd/git/fs, тесты и неоднозначный shell только из записанной копии. Сообщение на строке 851 отдельно оставляет проверку без изменений из `main`.
- `activeWorktreePathDecision` (строки 866–899): `edit` / `write` только внутрь записанной копии.
- `requiredToolCwdDecision` (строки 902–917): `dispatch_supervisor`, `dispatch_reviewer`, `dispatch_docs_agent`, `review_bead` идут в ту же копию через `requireTaskToolTarget`.

Читать из файла проекта: `copyRequired` и `handoffFromCopy`. Если копия не нужна, lock на чужой `copyRoot` требовать нельзя.

### 4. Записанный путь копии должен быть корнем репозитория и не main

Путь: `.pi/extensions/worktree-scope/index.ts:108` `validateTaskScopePath`.

Требует: путь есть, это корень git, ветка не `main`/`master` (`PROTECTED_BRANCHES`, строка 6 и 126), ожидаемая ветка совпадает.

`requireTaskToolTarget` (строки 192–205) отклоняет `cwd` / `worktreePath` снаружи записанной копии.

Охрана импортирует это на `.pi/extensions/beads-policy/index.ts:5`.

Читать из файла проекта: `copyRequired`. Без копии protected-branch check не должен притворяться, что `main` — задача.

### 5. Claim с main не записывает main как задачу и ищет только трекерный корень

Путь: `.pi/extensions/workflow-state/index.ts:76` — тот же `WORKTREE_ROOT`.

`isCanonicalExistingTaskWorktree` (строки 284–294) считает существующую копию своей, только если ветка каноническая, suffix начинается с суффикса bead, basename равен suffix и путь внутри `WORKTREE_ROOT`.

`nonProtectedGitScope` (строки 481–486) выкидывает branch/worktree/start, если текущая ветка `main` или `master`. Claim из checkout `main` сам по себе task scope не создаёт.

Читать из файла проекта: `copyRoot` и `copyRequired`. Иначе автопоиск чужие копии не увидит, а трекерные увидит.

### 6. Skill заставляет создать копию до плана

Путь: `.pi/skills/claim-bead/SKILL.md:18–23`.

Требует: если записанная копия пустая, отсутствует или это всё ещё `main`/`master`, до `workflow_plan_mode` выполнить `bd worktree create <absolute-path> --branch <branch>`, затем `scripts/setup-worktree.sh`, затем `workflow_update` с worktree/branch/start. Уже привязанную единственную каноническую копию не создавать второй раз. Сырой `git worktree add` skill запрещает, пока действует main-mutation policy.

`scripts/setup-worktree.sh:1–10` после create делает symlink `.env` и `pnpm install`. Пример пути в комментарии — снова корень трекера.

Читать из файла проекта: `copyRequired`. Если копия не нужна, шаг create/setup не запускать. Skill установщик не редактирует; звено само должно прочитать файл.

### 7. Одобрение плана не проходит без копии

Путь: `.pi/extensions/plan-mode/index.ts:641` `worktreeRecovery`.

Требует: если на approval или continuation нет абсолютного пути копии и канонической ветки не `main`/`master`, восстановление — один `bd worktree create` из checkout проекта, затем повтор `workflow_plan_approved` или `dispatch_supervisor`. Вторая человеческая апрува для recovery не нужна.

Читать из файла проекта: `copyRequired`. Если копия не нужна, recovery не должен требовать create.

### 8. Сдача и отчёт предполагают копию

Путь: `.pi/skills/land/SKILL.md:12`. Пока записан `worktreePath`, save/push не из `main`. `main` до явного `merge-to-main` только для чтения.

Путь: `.pi/skills/merge-to-main/SKILL.md:12`. До merge PR mutating-команды, docs dispatch, тесты, commit и push ветки идут из копии. Локальная уборка копии — шаг 12, строки 152–158, и только из primary checkout `main`, после merge.

Путь: `AGENTS.md:91–96`. Если коммит не предок `main`, отчёт содержит секцию «Не в main»: правка лежит в worktree, в `main` файлов нет. Пункт сдачи начинается словами «Смержить worktree в `main`».

Читать из файла проекта: `handoffFromCopy`. Если копии не было, отчёт «Не в main» и merge копии не ритуал этой задачи.

## Соседние цепочки

Названы, в этой задаче не размотаны. Не смешивать с worktree, пока звенья выше не читают файл проекта:

- закрытие без ревью;
- матрица приёмки;
- запись в main;
- проверки команд (`pnpm`, `vue-tsc` и соседние gate);
- язык задач;
- имена агентов vue/tauri.

## Три примера — проверка спеки, не реализация

Трекер. `copyRequired=yes`, `copyRoot` как в звене 1, ревью остаётся. Цепочка выше описывает то, что код делает сейчас. Менять код этой спекой нельзя.

Haasbot. Основная работа — стратегия и версии скриптов, не продукт. `copyRequired=no`. Отдельный documentation-expert не нужен: запись изменения пишет тот, кто менял стратегию. Пока звенья 6–8 не читают `copyRequired`, охрана этого репозитория такой проект не пропустит. Это дыра цепочки, не повод копировать `.pi` в Haasbot из этой задачи.

Hummingbot. В одном проекте две дороги. Стратегия: `copyRequired=no`. Правки ядра: `copyRequired=yes` и свой `handoffFromCopy`. Один файл проекта должен уметь ответить по дороге, а не одним флагом на весь репозиторий. Схемы дорог здесь нет: соседние цепочки не размотаны. Для worktree достаточно, что `copyRequired` не глобален навсегда, если в проекте больше одной дороги.

## Что следующая сессия делает с этой спекой

Переключает звенья 1–8 так, чтобы каждое читало файл проекта, а не зашитый корень трекера. Установщик после этого только записывает файл. Установщик не редактирует `beads-policy`. Детей заводить после приёмки спеки, не пачкой заранее.
