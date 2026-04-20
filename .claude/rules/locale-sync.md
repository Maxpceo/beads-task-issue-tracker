---
name: locale-sync
description: UI-строки через $t('...'); ключи синхронно в en.json и ru.json; проектный контент и bd-идентификаторы НЕ переводятся.
paths:
  - "app/**/*.vue"
  - "app/**/*.ts"
  - "i18n/locales/*.json"
---

# Locale Sync (i18n)

- **Никаких сырых строк в UI.** В `<template>` и UI-логике — только `$t('namespace.key')`. В composables/utils — `const { t } = useI18n()` и `t('key')`.
- **Why**: в проекте 2 языка (en/ru). Захардкоженная строка = баг для второго языка, который найдётся поздно.

## Namespaces

Существующие top-level: `about`, `app`, `common`, `dashboard`, `details`, `issues`, `layout`, `menu`, `notifications`, `page`, `settings`. **Переиспользовать**; новый namespace — только если не лезет ни в один существующий.

Naming: nested dot-separated, короткие lowerCamelCase сегменты (напр. `settings.language.auto`, `issues.filters.clearAll`).

## Синхронизация en.json ↔ ru.json

Любое добавление / удаление / переименование ключа — **одновременно** в `i18n/locales/en.json` и `ru.json`. Структура ключей должна быть идентичной.

Sync-check (возвращает пустой diff, если всё ок):

```bash
jq -S 'paths(scalars)' i18n/locales/en.json i18n/locales/ru.json | diff -
```

## Что НЕ переводится

- **Пользовательский контент**: title / description / notes / design / acceptance issues, комментарии. Язык выбирает автор содержимого.
- **bd-идентификаторы**: status (`in_progress`, `inreview`, ...), type (`feature`, `bug`, ...), priority (`P0`–`P4`), labels (`frontend`, `ui`, ...).
- **Имена файлов, функций, переменных, API-полей.**
- **Нативные macOS-меню** — у них свой механизм локализации.

## Добавление нового ключа — чек-лист

1. Найди существующий namespace, куда ложится по смыслу.
2. Добавь ключ в `en.json` и `ru.json` одновременно.
3. Используй `$t('...')` в UI / `t('...')` в TS.
4. Прогон sync-check командой выше.

## Автоматическая проверка при review

Skill `reviewing-code` Step 2.7 автоматически сверяет добавленные `$t('...')` ключи с `en.json` и `ru.json` после `inreview`. Ручная проверка — `jq -S` команда выше.
