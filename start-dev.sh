#!/bin/bash

# Запуск Beads Task-Issue Tracker в режиме разработки
# Использование: ./start-dev.sh
#
# Что делает:
# 1. Убивает зомби-процессы от предыдущего запуска
# 2. Проверяет зависимости (pnpm, Rust, bd CLI)
# 3. Запускает Tauri dev (frontend + backend в одном окне)

set -e

# Отключить Nuxt telemetry промпт (блокирует dev server)
export NUXT_TELEMETRY_DISABLED=1

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Директории
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR"

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}  Beads Task-Issue Tracker — Dev Mode${NC}"
echo -e "${BLUE}==================================================${NC}"
echo ""

# [1/5] Убить зомби-процессы
#
# ВАЖНО: установленное приложение в /Applications/Beads Task-Issue Tracker.app НЕ трогаем:
# - Его бинарник называется "beads-issue-tracker" (без "task")
# - Его абсолютный путь не содержит $PROJECT_ROOT
# Все паттерны ниже привязаны либо к $PROJECT_ROOT, либо к имени "beads-task-issue-tracker"
# (npm-имя проекта, которое у установленного приложения в командной строке не встречается).
echo -e "${YELLOW}[1/5] Убиваю зомби-процессы...${NC}"
KILLED=0

# Dev Tauri Rust-бинарник (scoped к target/debug, установленное приложение не матчится)
if pkill -9 -f "$PROJECT_ROOT/src-tauri/target/debug/beads-issue-tracker" 2>/dev/null; then
    KILLED=$((KILLED + 1))
fi
if pkill -9 -f "beads-task-issue-tracker" 2>/dev/null; then
    KILLED=$((KILLED + 1))
fi

# Node.js dev-server процессы (pnpm tauri:dev, @tauri-apps/cli, nuxt, vite, esbuild) —
# все scoped через абсолютный путь $PROJECT_ROOT, чтобы не задеть чужие Vite на других проектах
for pattern in \
    "$PROJECT_ROOT.*nuxt.*dev" \
    "$PROJECT_ROOT.*tauri.*dev" \
    "$PROJECT_ROOT.*vite" \
    "$PROJECT_ROOT.*esbuild" \
    "$PROJECT_ROOT.*pnpm.*tauri" ; do
    if pkill -9 -f "$pattern" 2>/dev/null; then
        KILLED=$((KILLED + 1))
    fi
done

if [ $KILLED -gt 0 ]; then
    echo -e "${YELLOW}Убито $KILLED групп зомби-процессов${NC}"
    sleep 2
else
    echo -e "${GREEN}Зомби не найдены${NC}"
fi

# Проверка: порты 3000 и 3133 должны быть свободны. Иначе Nuxt падает на альтернативный порт,
# а Tauri грузит с settings-порта — окно оказывается пустым или со старым бандлом.
# Освобождаем ТОЛЬКО если порт держит процесс из нашего проекта (чужие Vite не трогаем).
#
# Принадлежность определяем по cwd процесса, а не по строке команды: argv может содержать
# относительный путь (./node_modules/...) и не совпасть с $PROJECT_ROOT, хотя процесс наш.
for port in 3000 3133; do
    PID=$(lsof -iTCP:$port -sTCP:LISTEN -t 2>/dev/null | head -1)
    if [ -n "$PID" ]; then
        CWD=$(lsof -a -d cwd -p "$PID" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
        CMD=$(ps -p "$PID" -o command= 2>/dev/null || echo "")
        if [ -n "$CWD" ] && [[ "$CWD" == "$PROJECT_ROOT"* ]]; then
            echo -e "${YELLOW}Порт $port держит зомби $PID из нашего проекта — убиваю${NC}"
            kill -9 "$PID" 2>/dev/null
            sleep 1
        else
            echo -e "${RED}⚠ Порт $port занят процессом $PID из другого проекта (не трогаю):${NC}"
            echo -e "${RED}  cwd: ${CWD:-<не определено>}${NC}"
            echo -e "${RED}  $CMD${NC}"
            echo -e "${RED}  Остановите его вручную и запустите скрипт заново${NC}"
            exit 1
        fi
    fi
done
echo ""

# [1.5/5] Очистка dev-кешей — на случай, если HMR упал и Vite держит устаревшие модули
echo -e "${YELLOW}[1.5/5] Очищаю dev-кеши (.nuxt, node_modules/.vite, node_modules/.cache)...${NC}"
rm -rf "$PROJECT_ROOT/.nuxt" "$PROJECT_ROOT/node_modules/.vite" "$PROJECT_ROOT/node_modules/.cache" 2>/dev/null
echo -e "${GREEN}Кеши очищены${NC}"
echo ""

# [2/5] Проверка pnpm и зависимостей
echo -e "${YELLOW}[2/5] Проверка Node.js зависимостей...${NC}"
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}pnpm не найден!${NC}"
    echo -e "${YELLOW}Установи: npm install -g pnpm${NC}"
    exit 1
fi

if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
    echo -e "${YELLOW}node_modules не найдены, устанавливаю...${NC}"
    cd "$PROJECT_ROOT"
    pnpm install
fi
echo -e "${GREEN}pnpm $(pnpm --version) — зависимости готовы${NC}"
echo ""

# [3/5] Проверка Rust
echo -e "${YELLOW}[3/5] Проверка Rust toolchain...${NC}"
if ! command -v cargo &> /dev/null; then
    echo -e "${RED}Rust не найден!${NC}"
    echo -e "${YELLOW}Установи: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh${NC}"
    exit 1
fi
echo -e "${GREEN}Rust $(rustc --version | cut -d' ' -f2) — готов${NC}"
echo ""

# [4/5] Проверка bd CLI
echo -e "${YELLOW}[4/5] Проверка bd CLI...${NC}"
if command -v bd &> /dev/null; then
    BD_VERSION=$(bd --version 2>/dev/null | head -1 || echo "unknown")
    echo -e "${GREEN}bd $BD_VERSION — готов${NC}"
elif command -v br &> /dev/null; then
    BR_VERSION=$(br --version 2>/dev/null | head -1 || echo "unknown")
    echo -e "${GREEN}br $BR_VERSION — готов${NC}"
else
    echo -e "${YELLOW}⚠ bd/br CLI не найден — приложение запустится, но без трекера задач${NC}"
fi
echo ""

# [5/5] Запуск Tauri dev
echo -e "${YELLOW}[5/5] Запуск Tauri dev server...${NC}"
echo ""
echo -e "${BLUE}==================================================${NC}"
echo -e "${GREEN}  ЗАПУСКАЮ!${NC}"
echo -e "${BLUE}==================================================${NC}"
echo ""
echo -e "  ${CYAN}Что произойдёт:${NC}"
echo -e "  1. Nuxt скомпилирует frontend (Vue/TypeScript)"
echo -e "  2. Cargo скомпилирует backend (Rust) — первый раз ~2-3 мин"
echo -e "  3. Откроется окно приложения"
echo ""
echo -e "  ${CYAN}Горячая перезагрузка:${NC}"
echo -e "  • .vue / .ts файлы — ${GREEN}мгновенно${NC} (hot-reload)"
echo -e "  • .rs файлы — ${YELLOW}~20-30 сек${NC} (перекомпиляция Rust)"
echo ""
echo -e "  ${CYAN}Полезные команды:${NC}"
echo -e "  • ${YELLOW}Cmd+Option+I${NC} — DevTools в окне приложения"
echo -e "  • ${YELLOW}pnpm test${NC} — запустить тесты (в другом терминале)"
echo -e "  • ${YELLOW}npx vue-tsc --noEmit${NC} — проверить TypeScript типы"
echo ""
echo -e "  ${CYAN}Логи:${NC}"
echo -e "  • Приложение: ${YELLOW}tail -f ~/Library/Logs/com.beads.manager/beads.log${NC}"
echo ""
echo -e "${RED}  Ctrl+C — остановить${NC}"
echo -e "${BLUE}==================================================${NC}"
echo ""

cd "$PROJECT_ROOT"
pnpm tauri:dev
