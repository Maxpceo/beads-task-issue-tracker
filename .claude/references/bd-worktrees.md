# bd worktrees — изоляция параллельных сессий

Справочник для orchestrator'а. Решение об использовании принимает сам оркестратор — это возможность, не обязательство.

## Зачем нужен

`bd worktree` создаёт git worktree с общей beads DB (через git common directory discovery). Разные worktrees = разные директории на диске, но одна база задач и история. Изолирует файлы при параллельной работе.

## Когда оправдан

- **Вторая сессия Claude Code при активной первой.** Пользователь открыл ещё одну сессию, хочет дать ей задачу, а первая ещё работает. Worktree предотвращает конфликты `git add` и перезапись файлов.
- **Epic с независимыми children.** Children без зависимостей можно dispatch'ить параллельно, каждому — свой worktree.
- **Срочный hot-fix.** Основная сессия занята длинной задачей, нужно срочно починить другое — открыть worktree, не прерывая основную.

## Когда НЕ нужен

- Одна активная сессия — избыточный оверхед.
- Fast Path (1 файл, <20 строк) — создание worktree дороже самой задачи.
- Последовательные задачи в одной сессии — ветка + рабочая директория справляются.

## Layout (external)

Worktrees живут во внешней директории `~/Projects/worktrees/beads-task-issue-tracker/<branch>/`, а не внутри репо. Это даёт:
- чистое `git status` в корне репо (не видит чужие worktrees);
- возможность удалить worktree физически, не трогая репо;
- хуки надёжно различают orchestrator ↔ supervisor по пути CWD.

### Создание

```bash
# 1. Родительская директория (один раз)
mkdir -p ~/Projects/worktrees/beads-task-issue-tracker

# 2. Создать worktree + ветку
bd worktree create ~/Projects/worktrees/beads-task-issue-tracker/<name> --branch <name>

# 3. MANDATORY: настроить окружение worktree
./scripts/setup-worktree.sh ~/Projects/worktrees/beads-task-issue-tracker/<name>

# 4. Зайти и работать
cd ~/Projects/worktrees/beads-task-issue-tracker/<name>
```

### Что делает `setup-worktree.sh`

- Создаёт symlink `.env → $REPO_ROOT/.env` (если `.env` в репо есть).
- Запускает `pnpm install` в worktree. pnpm использует глобальный content-addressable store (`~/Library/pnpm/store`) — установка создаёт symlinks в store, не копирует мегабайты.

### Что НЕ шарится и почему

- **`src-tauri/target/`** — каждая worktree имеет свой. Symlink ломает `cargo clean` (cargo#7510), общий `CARGO_TARGET_DIR` даёт global lock и блокирует параллельную сборку. Первая `cargo build` в новой worktree займёт минуты — это ожидаемо.
- **`.nuxt/`** — генерируется Nuxt'ом за 10–30 сек. Шаринг ломает параллельный `pnpm dev` из двух worktree (они будут перезаписывать одну и ту же папку).

### Удаление

```bash
bd worktree remove <name>               # удаляет worktree (with safety checks)
git branch -D <name>                    # удалить ветку, если уже не нужна
```

## Команды bd worktree

```bash
bd worktree create <path> --branch <branch>  # <path> = абсолютный external путь, см. пример выше (строка 35)
bd worktree list                             # список активных
bd worktree info                             # инфо о текущем (если внутри worktree)
bd worktree remove <name>                    # удалить (safety checks)
```

## Stale vs main guard

Хук `.claude/hooks/enforce-worktree-fresh-vs-main.sh` ловит коммиты в worktree, когда feature-ветка отстала от `origin/main` и staged файлы пересекаются с изменениями в main.

- Hard deny при пересечении файлов (риск франкенштейн-коммита).
- Soft reminder, если пересечения нет.
- Escape: `CLAUDE_SKIP_STALE_CHECK=1 git commit ...`.
- Recovery: `git fetch origin && git rebase origin/main`.

## Ручная проверка хука (E2E)

```bash
# Подготовить smoke worktree
mkdir -p ~/Projects/worktrees/beads-task-issue-tracker
bd worktree create ~/Projects/worktrees/beads-task-issue-tracker/smoke-stale --branch smoke-stale
./scripts/setup-worktree.sh ~/Projects/worktrees/beads-task-issue-tracker/smoke-stale
cd ~/Projects/worktrees/beads-task-issue-tracker/smoke-stale

# Отстать от main + править файл, пересекающийся с main-diff
git reset --hard HEAD~5
echo "x" >> app/pages/index.vue
git add app/pages/index.vue
git commit -m "test"   # должен быть DENIED

# Escape
CLAUDE_SKIP_STALE_CHECK=1 git commit -m "test"  # должен пройти

# Cleanup
cd -
bd worktree remove smoke-stale
git branch -D smoke-stale
```
