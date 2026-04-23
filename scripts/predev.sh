#!/usr/bin/env bash
# predev.sh — pre-flight перед `tauri dev` для этого репо.
#
# Зачем: если зомби-Nuxt от прошлой сессии держит порт 3133, новый Nuxt падает
# на 3000, а Tauri webview грузит 3133 → белый экран. Также голый
# `pkill -f "beads-issue-tracker"` убил бы установленное `.app` (одинаковое
# имя процесса) — здесь pkill scoped к полному пути dev-бинарника.
#
# Что делает:
#   1. Проверяет порт 3133. Если занят процессом из этого репо — убивает.
#      Если занят посторонним — выходит с понятным сообщением, ничего не трогая.
#   2. Убивает зомби dev-бинарника по полному пути ($PWD/src-tauri/target/...).
#      Установленный `/Applications/Beads Task-Issue Tracker.app` не задевается.
#   3. exec в `tauri dev --features dev-mcp` (signal forwarding).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=3133
DEV_BINARY="$REPO_ROOT/src-tauri/target/debug/beads-issue-tracker"

# Step 1: освободить порт 3133, только если держит процесс из этого репо.
PIDS_ON_PORT=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)

if [[ -n "$PIDS_ON_PORT" ]]; then
  for pid in $PIDS_ON_PORT; do
    # cwd процесса по lsof: формат `n<path>` после `p<pid>`.
    # `awk … exit` ломает pipefail через SIGPIPE; вместо этого grep+head+sed.
    PROC_CWD=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | head -1 | sed 's/^n//')

    if [[ "$PROC_CWD" == "$REPO_ROOT"* ]]; then
      echo "[predev] Killing stale process on :$PORT (pid=$pid, cwd=$PROC_CWD)" >&2
      kill "$pid" 2>/dev/null || true
      # Дать процессу 2с на graceful shutdown, потом SIGKILL если выжил.
      for _ in 1 2 3 4; do
        sleep 0.5
        kill -0 "$pid" 2>/dev/null || break
      done
      kill -9 "$pid" 2>/dev/null || true
    else
      echo "[predev] ERROR: port $PORT is held by a foreign process (pid=$pid, cwd=${PROC_CWD:-unknown})." >&2
      echo "[predev] Refusing to kill. Free the port manually, then re-run pnpm tauri:dev." >&2
      exit 1
    fi
  done
fi

# Step 2: scoped kill зомби dev-бинарника. `|| true` — отсутствие процесса не ошибка.
pkill -f "$DEV_BINARY" 2>/dev/null || true

# Step 3: запуск Tauri dev. exec — signals доходят до tauri/cargo.
exec pnpm exec tauri dev --features dev-mcp
