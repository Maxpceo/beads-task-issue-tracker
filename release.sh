#!/bin/bash

# Выпуск новой версии Beads Task-Issue Tracker
# Использование:
#   ./release.sh            — создать релиз (тесты, версия, тег, push)
#   ./release.sh --publish  — опубликовать черновик после проверки файлов
#
# Интерактивный скрипт — спрашивает подтверждение на каждом шаге.
# Обновляет версию в package.json, tauri.conf.json и Cargo.toml,
# создаёт коммит, тег и пушит. GitHub Actions соберёт DMG/EXE/AppImage.

set -e

# ── Режим --publish ──
if [[ "${1:-}" == "--publish" ]]; then
  # Цвета
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  NC='\033[0m'

  echo -e "${BLUE}==================================================${NC}"
  echo -e "${BLUE}  Публикация релиза${NC}"
  echo -e "${BLUE}==================================================${NC}"
  echo ""

  # Найти последний draft-релиз
  DRAFT_TAG=$(gh release list --json tagName,isDraft --jq '.[] | select(.isDraft) | .tagName' | head -1)
  if [[ -z "$DRAFT_TAG" ]]; then
    echo -e "${RED}  Нет черновиков для публикации.${NC}"
    exit 1
  fi

  echo -e "  Найден черновик: ${GREEN}$DRAFT_TAG${NC}"
  echo ""

  # Проверить файлы
  echo -e "${CYAN}Проверка файлов:${NC}"
  ASSETS=$(gh release view "$DRAFT_TAG" --json assets --jq '.assets[] | "\(.name) — \(.size / 1048576 * 10 | floor / 10) MB"')
  ASSET_COUNT=$(gh release view "$DRAFT_TAG" --json assets --jq '.assets | length')

  echo "$ASSETS" | while read -r line; do
    echo -e "  ${GREEN}✓${NC} $line"
  done
  echo ""

  if [[ "$ASSET_COUNT" -lt 6 ]]; then
    echo -e "${RED}  Ожидается 6 файлов, найдено $ASSET_COUNT. Сборка ещё не завершена?${NC}"
    echo -e "  ${YELLOW}Проверь: https://github.com/Maxpceo/beads-task-issue-tracker/actions${NC}"
    exit 1
  fi

  echo -e "  ${GREEN}Все $ASSET_COUNT файлов на месте${NC}"
  echo ""
  read -p "Опубликовать $DRAFT_TAG? (y/n): " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Отменено.${NC}"
    exit 1
  fi

  gh release edit "$DRAFT_TAG" --draft=false
  echo ""
  echo -e "${GREEN}  Релиз $DRAFT_TAG опубликован!${NC}"
  echo -e "  ${YELLOW}https://github.com/Maxpceo/beads-task-issue-tracker/releases/tag/$DRAFT_TAG${NC}"
  exit 0
fi

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

if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo -e "${RED}  Релизы делаются только из main!${NC}"
  echo -e "  Сначала смерджи свою ветку:"
  echo -e "    ${YELLOW}git checkout main && git merge $CURRENT_BRANCH${NC}"
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
echo ""
echo -e "${YELLOW}Запустить pnpm test && npx vue-tsc --noEmit?${NC}"
read -p "Продолжить? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
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
else
  echo -e "  ${YELLOW}Тесты пропущены${NC}"
fi
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
  CARGO_TOML="src-tauri/Cargo.toml"
  CARGO_LOCK="src-tauri/Cargo.lock"

  echo -e "${CYAN}Шаг 6: Обновление версии в файлах${NC}"
  echo ""
  echo -e "  ${YELLOW}package.json:${NC}        $CURRENT_VERSION → ${GREEN}$NEW_VERSION${NC}"
  echo -e "  ${YELLOW}tauri.conf.json:${NC}     $CURRENT_VERSION → ${GREEN}$NEW_VERSION${NC}"
  echo -e "  ${YELLOW}Cargo.toml:${NC}          $(grep '^version' "$CARGO_TOML" | head -1 | sed 's/.*"\(.*\)"/\1/') → ${GREEN}$NEW_VERSION${NC}"
  echo -e "  ${YELLOW}Cargo.lock:${NC}          beads-issue-tracker → ${GREEN}$NEW_VERSION${NC}"
  confirm "Обновить версию во всех файлах?"

  # Обновить package.json
  npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version > /dev/null

  # Обновить tauri.conf.json
  if [[ -f "$TAURI_CONF" ]]; then
    sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$TAURI_CONF"
  else
    echo -e "${RED}  tauri.conf.json не найден!${NC}"
    exit 1
  fi

  # Обновить Cargo.toml
  if [[ -f "$CARGO_TOML" ]]; then
    sed -i '' "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$CARGO_TOML"
  else
    echo -e "${RED}  Cargo.toml не найден!${NC}"
    exit 1
  fi

  # Обновить Cargo.lock (только строку version под beads-issue-tracker).
  # Иначе после релиза lockfile дрейфует относительно Cargo.toml и
  # ломает 'clean working tree' проверку при следующем запуске release.sh.
  if [[ -f "$CARGO_LOCK" ]]; then
    awk -v new="$NEW_VERSION" '
      /^name = "beads-issue-tracker"$/ { found=1; print; next }
      found && /^version = / { print "version = \"" new "\""; found=0; next }
      { print }
    ' "$CARGO_LOCK" > "$CARGO_LOCK.tmp" && mv "$CARGO_LOCK.tmp" "$CARGO_LOCK"
  else
    echo -e "${RED}  Cargo.lock не найден!${NC}"
    exit 1
  fi

  echo -e "  ${GREEN}Все 4 файла обновлены${NC}"
  echo ""

  # ── Шаг 7: Коммит ──
  echo -e "${CYAN}Шаг 7: Создание коммита${NC}"
  echo ""
  echo -e "  Сообщение: ${GREEN}release: v$NEW_VERSION${NC}"
  echo -e "  Файлы: package.json, $TAURI_CONF, $CARGO_TOML, $CARGO_LOCK"
  confirm "Создать коммит?"

  git add package.json "$TAURI_CONF" "$CARGO_TOML" "$CARGO_LOCK"
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
echo -e "  ${CYAN}Когда сборка завершится:${NC}"
echo -e "  1. Проверь что всё собралось: ${YELLOW}gh release view v$NEW_VERSION${NC}"
echo -e "  2. Опубликуй: ${YELLOW}./release.sh --publish${NC}"
echo ""
