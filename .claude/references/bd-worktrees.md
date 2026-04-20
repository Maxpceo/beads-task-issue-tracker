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

## Команды

```bash
bd worktree create <name> --branch <branch>   # Создать worktree в .worktrees/<name>
bd worktree list                              # Список активных worktrees
bd worktree info                              # Инфо о текущем (если внутри worktree)
bd worktree remove <name>                     # Удалить (с safety checks)
```

Worktrees создаются в `.worktrees/` (в `.gitignore`).

## Stale vs main guard

Хук `.claude/hooks/enforce-worktree-fresh-vs-main.sh` автоматически ловит коммиты в worktree, когда feature-ветка отстала от `origin/main` и staged файлы пересекаются с изменениями в main.

- Hard deny при пересечении файлов (есть риск франкенштейн-коммита).
- Soft reminder, если пересечения нет.
- Escape: `CLAUDE_SKIP_STALE_CHECK=1 git commit ...`.
- Recovery: `git fetch origin && git rebase origin/main`.

## Ручная проверка хука (E2E)

```bash
# E2E: hard deny при пересечении
git worktree add .worktrees/test-stale -b test-stale main
cd .worktrees/test-stale
git reset --hard HEAD~5  # отстать от main
echo "x" >> app/pages/index.vue
git add app/pages/index.vue
git commit -m "test"   # должен быть DENIED

# Escape
CLAUDE_SKIP_STALE_CHECK=1 git commit -m "test"  # должен пройти

# Cleanup
cd ../..
git worktree remove .worktrees/test-stale --force
git branch -D test-stale
```
