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
echo -e "${YELLOW}[1/5] Убиваю зомби-процессы...${NC}"
KILLED=0
if pkill -f "beads-issue-tracker" 2>/dev/null; then
    KILLED=$((KILLED + 1))
fi
if pkill -f "beads-task-issue-tracker" 2>/dev/null; then
    KILLED=$((KILLED + 1))
fi
if [ $KILLED -gt 0 ]; then
    echo -e "${YELLOW}Убито $KILLED зомби-процессов${NC}"
    sleep 1
else
    echo -e "${GREEN}Зомби не найдены${NC}"
fi
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
