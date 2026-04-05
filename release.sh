#!/bin/bash

# Выпуск новой версии Beads Task-Issue Tracker
# Использование: ./release.sh
#
# Интерактивный скрипт — спрашивает подтверждение на каждом шаге.
# Обновляет версию в package.json и tauri.conf.json,
# создаёт коммит, тег и пушит. GitHub Actions соберёт DMG/EXE/AppImage.

set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$PROJECT_ROOT"

# Функция подтверждения
confirm() {
  echo ""
  echo -e "${YELLOW}$1${NC}"
  read -p "Продолжить? (y/n): " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Отменено.${NC}"
    exit 1
  fi
}

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}  Beads Task-Issue Tracker — Release${NC}"
echo -e "${BLUE}==================================================${NC}"
echo ""

# ── Шаг 1: Проверить ветку ──
CURRENT_BRANCH=$(git branch --show-current)
echo -e "${CYAN}Шаг 1: Проверка ветки${NC}"
echo -e "  Текущая ветка: ${GREEN}$CURRENT_BRANCH${NC}"

if [[ "$CURRENT_BRANCH" != "master" && "$CURRENT_BRANCH" != "main" ]]; then
  echo -e "${RED}  Релизы делаются только из master/main!${NC}"
  echo -e "  Сначала смерджи свою ветку:"
  echo -e "    ${YELLOW}git checkout master && git merge $CURRENT_BRANCH${NC}"
  exit 1
fi
echo -e "  ${GREEN}OK${NC}"
echo ""

# ── Шаг 2: Проверить чистоту ──
echo -e "${CYAN}Шаг 2: Проверка незакоммиченных изменений${NC}"
if [[ -n $(git status --porcelain) ]]; then
  echo -e "${RED}  Есть незакоммиченные изменения:${NC}"
  git status --short
  echo ""
  echo -e "  ${YELLOW}Закоммить или stash перед релизом.${NC}"
  exit 1
fi
echo -e "  ${GREEN}Рабочая директория чистая${NC}"
echo ""

# ── Шаг 3: Тесты ──
echo -e "${CYAN}Шаг 3: Запуск тестов${NC}"
confirm "Запустить pnpm test && npx vue-tsc --noEmit?"

echo -e "  Запускаю тесты..."
if ! pnpm test 2>&1; then
  echo -e "${RED}  Тесты упали! Исправь перед релизом.${NC}"
  exit 1
fi
echo -e "  ${GREEN}Тесты пройдены${NC}"

echo -e "  Проверяю TypeScript..."
if ! npx vue-tsc --noEmit 2>&1; then
  echo -e "${RED}  TypeScript ошибки! Исправь перед релизом.${NC}"
  exit 1
fi
echo -e "  ${GREEN}TypeScript OK${NC}"
echo ""

# ── Шаг 4: Выбор версии ──
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${CYAN}Шаг 4: Выбор новой версии${NC}"
echo -e "  Текущая версия: ${GREEN}v$CURRENT_VERSION${NC}"
echo ""

# Предложить варианты
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEXT_PATCH="$MAJOR.$MINOR.$((PATCH + 1))"
NEXT_MINOR="$MAJOR.$((MINOR + 1)).0"
NEXT_MAJOR="$((MAJOR + 1)).0.0"

echo -e "  Варианты:"
echo -e "    1) ${GREEN}$NEXT_PATCH${NC}  — patch (исправления багов)"
echo -e "    2) ${GREEN}$NEXT_MINOR${NC}  — minor (новые фичи)"
echo -e "    3) ${GREEN}$NEXT_MAJOR${NC}  — major (большие изменения)"
echo -e "    4) Ввести вручную"
echo ""
read -p "  Выбери (1/2/3/4): " -n 1 -r VERSION_CHOICE
echo ""

case $VERSION_CHOICE in
  1) NEW_VERSION="$NEXT_PATCH" ;;
  2) NEW_VERSION="$NEXT_MINOR" ;;
  3) NEW_VERSION="$NEXT_MAJOR" ;;
  4)
    read -p "  Введи версию (без v): " NEW_VERSION
    ;;
  *)
    echo -e "${RED}Неверный выбор.${NC}"
    exit 1
    ;;
esac

# Валидация формата
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo -e "${RED}  Неверный формат версии: $NEW_VERSION (ожидается X.Y.Z)${NC}"
  exit 1
fi

echo ""
echo -e "  ${GREEN}Новая версия: v$NEW_VERSION${NC}"
echo ""

# ── Шаг 5: Проверить CHANGELOG ──
echo -e "${CYAN}Шаг 5: Проверка CHANGELOG${NC}"
if grep -q "\[$NEW_VERSION\]" CHANGELOG.md; then
  echo -e "  ${GREEN}Запись [$NEW_VERSION] найдена в CHANGELOG.md${NC}"
else
  echo -e "${RED}  Запись [$NEW_VERSION] НЕ найдена в CHANGELOG.md!${NC}"
  echo -e "  ${YELLOW}Добавь запись перед релизом:${NC}"
  echo ""
  echo -e "    ## [$NEW_VERSION] - $(date +%Y-%m-%d)"
  echo -e "    "
  echo -e "    ### New Features"
  echo -e "    - ..."
  echo ""
  exit 1
fi
echo ""

# ── Шаг 6: Обновить версию в файлах ──
TAURI_CONF="src-tauri/tauri.conf.json"

if [[ "$CURRENT_VERSION" == "$NEW_VERSION" ]]; then
  echo -e "${CYAN}Шаг 6: Версия уже $NEW_VERSION — пропускаю обновление файлов${NC}"
  echo ""
  echo -e "${CYAN}Шаг 7: Коммит не нужен — версия не изменилась${NC}"
  echo ""
else
  echo -e "${CYAN}Шаг 6: Обновление версии в файлах${NC}"
  echo ""
  echo -e "  ${YELLOW}package.json:${NC}        $CURRENT_VERSION → ${GREEN}$NEW_VERSION${NC}"
  echo -e "  ${YELLOW}tauri.conf.json:${NC}     $CURRENT_VERSION → ${GREEN}$NEW_VERSION${NC}"
  confirm "Обновить версию в обоих файлах?"

  # Обновить package.json
  npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version > /dev/null

  # Обновить tauri.conf.json
  if [[ -f "$TAURI_CONF" ]]; then
    sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$TAURI_CONF"
    echo -e "  ${GREEN}Оба файла обновлены${NC}"
  else
    echo -e "${RED}  tauri.conf.json не найден!${NC}"
    exit 1
  fi
  echo ""

  # ── Шаг 7: Коммит ──
  echo -e "${CYAN}Шаг 7: Создание коммита${NC}"
  echo ""
  echo -e "  Сообщение: ${GREEN}release: v$NEW_VERSION${NC}"
  echo -e "  Файлы: package.json, $TAURI_CONF"
  confirm "Создать коммит?"

  git add package.json "$TAURI_CONF"
  git commit -m "release: v$NEW_VERSION"
  echo -e "  ${GREEN}Коммит создан${NC}"
  echo ""
fi

# ── Шаг 8: Тег ──
echo -e "${CYAN}Шаг 8: Создание тега${NC}"
echo ""
echo -e "  Тег: ${GREEN}v$NEW_VERSION${NC}"
echo -e "  Это метка на коммите. GitHub Actions увидит тег v* и начнёт сборку."
confirm "Создать тег v$NEW_VERSION?"

git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"
echo -e "  ${GREEN}Тег v$NEW_VERSION создан${NC}"
echo ""

# ── Шаг 9: Push ──
echo -e "${CYAN}Шаг 9: Отправка на GitHub${NC}"
echo ""
echo -e "  Будет отправлено:"
echo -e "    1. Коммит с версией → ${GREEN}origin/$CURRENT_BRANCH${NC}"
echo -e "    2. Тег v$NEW_VERSION → GitHub Actions начнёт сборку"
confirm "Отправить на GitHub?"

git push origin "$CURRENT_BRANCH"
git push origin "v$NEW_VERSION"
echo ""

# ── Готово ──
echo -e "${BLUE}==================================================${NC}"
echo -e "${GREEN}  РЕЛИЗ v$NEW_VERSION ОТПРАВЛЕН!${NC}"
echo -e "${BLUE}==================================================${NC}"
echo ""
echo -e "  ${CYAN}Что происходит сейчас:${NC}"
echo -e "  GitHub Actions собирает приложение для macOS, Windows и Linux."
echo -e "  Это займёт ~10-15 минут."
echo ""
echo -e "  ${CYAN}Следи за прогрессом:${NC}"
echo -e "  ${YELLOW}https://github.com/Maxpceo/beads-task-issue-tracker/actions${NC}"
echo ""
echo -e "  ${CYAN}Релиз появится здесь:${NC}"
echo -e "  ${YELLOW}https://github.com/Maxpceo/beads-task-issue-tracker/releases${NC}"
echo ""
