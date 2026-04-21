#!/usr/bin/env bash
# setup-worktree.sh — подготовка внешнего worktree для работы.
#
# Использование: ./scripts/setup-worktree.sh <worktree_path>
# Пример:         ./scripts/setup-worktree.sh ~/Projects/worktrees/beads-task-issue-tracker/feat-foo
#
# Что делает:
#   1. Если в корне репо существует `.env` — создаёт symlink в worktree.
#   2. Запускает `pnpm install` внутри worktree (pnpm global store делает
#      это быстрым: копирования мегабайтов нет, только symlinks в store).
#
# Что НЕ делает (осознанно):
#   - `src-tauri/target/` не шарим. Symlink ломает `cargo clean` (cargo#7510),
#     общий CARGO_TARGET_DIR даёт global lock и не даёт параллельно собирать
#     две worktree. Первая `cargo build` в новой worktree займёт минуты —
#     это ожидаемо.
#   - `.nuxt/` не шарим. Генерируется Nuxt'ом за 10-30с; шаринг ломает
#     параллельный `pnpm dev` из двух worktree.

set -euo pipefail

WORKTREE_DIR="${1:-}"

if [[ -z "$WORKTREE_DIR" ]]; then
  echo "Использование: $0 <worktree_path>" >&2
  echo "Пример: $0 ~/Projects/worktrees/beads-task-issue-tracker/feat-foo" >&2
  exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)

# Преобразуем относительный путь в абсолютный
if [[ "$WORKTREE_DIR" != /* ]]; then
  WORKTREE_DIR="$REPO_ROOT/$WORKTREE_DIR"
fi

if [[ ! -d "$WORKTREE_DIR" ]]; then
  echo "Ошибка: директория $WORKTREE_DIR не существует" >&2
  echo "Сначала создайте worktree: bd worktree create $WORKTREE_DIR --branch <branch>" >&2
  exit 1
fi

echo "Setup worktree: $WORKTREE_DIR"
echo "Source repo:    $REPO_ROOT"
echo ""

# 1. .env — symlink
if [[ -f "$REPO_ROOT/.env" ]] && [[ ! -e "$WORKTREE_DIR/.env" ]]; then
  ln -sfn "$REPO_ROOT/.env" "$WORKTREE_DIR/.env"
  echo "✓ .env → $REPO_ROOT/.env"
elif [[ -e "$WORKTREE_DIR/.env" ]]; then
  echo "⊘ .env уже существует в worktree, пропускаю"
else
  echo "⊘ .env в репо не найден, пропускаю"
fi

# 2. pnpm install
if command -v pnpm >/dev/null 2>&1; then
  echo ""
  echo "Running pnpm install в worktree..."
  (cd "$WORKTREE_DIR" && pnpm install)
  echo "✓ pnpm install завершён"
else
  echo "⚠️  pnpm не найден — пропускаю install. Установите pnpm (https://pnpm.io) и запустите вручную."
fi

cat <<EOF

Готово. Первый запуск \`pnpm tauri:dev\` или \`cargo check\` в worktree
скомпилирует Rust и сгенерирует .nuxt/ с нуля — это ожидаемо (минуты).
Последующие сборки в той же worktree будут incremental.

  cd $WORKTREE_DIR
  pnpm tauri:dev   # или pnpm test, cargo check и т.д.
EOF
