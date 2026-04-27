---
title: 'i18n (EN + RU) для UI'
type: 'feature'
created: '2026-04-19'
status: 'in-progress'
baseline_commit: 'd0be714'
context:
  - '{project-root}/CLAUDE.md'
  - '{project-root}/.claude/codebase-map.md'
---

<!-- Spec Change Log: Ask First #3 (Nuxt 4 compat) resolved 2026-04-19 via separate PR #43 (Nuxt 4.3 → 4.4.2). Can now use @nuxtjs/i18n@10.2.4 (latest). -->

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Интерфейс только на английском. Русскоязычным пользователям неудобно — приходится переводить в уме лейблы, тултипы, сообщения.

**Approach:** Подключить `@nuxtjs/i18n` с двумя локалями (en, ru), вынести user-facing строки в JSON, добавить переключатель в Settings с auto-detect по системе на первом запуске.

## Boundaries & Constraints

**Always:**

- Все user-facing строки UI обёрнуты в `$t('key')` — никакого хардкода в компонентах
- Fallback language = `en`; если ключ отсутствует в `ru.json` — показываем EN-текст, не ключ
- Persistence: `useLocalStorage('beads:locale', null)` — `null` = auto, `'en'`/`'ru'` = explicit
- Missing-key warnings логируем через `logFrontend('warn', ...)` только в dev, в prod silent

**Ask First:**

- Встречена строка, склеенная через `+` / template literal с переменной в середине → HALT, решить: плюрализация или `$t('key', { var })`
- Встречен `v-html` с локализованной (не user-content) строкой → HALT (security)
- `@nuxtjs/i18n@9.x` несовместим с Nuxt 4 `compatibilityVersion: 4` → HALT, обсудить альтернативу
- Нативное меню Tauri не удаётся реактивно пересоздать → HALT, выбрать: требовать рестарт или оставить меню на EN

**Never:**

- Не переводить идентификаторы bd: статусы (`open`/`in_progress`/…), типы (`bug`/`task`/…), приоритеты (`P0`–`P4`). Badge-компоненты показывают идентификаторы as-is на любом языке
- Не переводить user-content: issue title, description, комментарии, labels
- Не переводить Rust backend: `log_*!`, error messages из Tauri команд — остаются EN (scope отдельного спека)
- Не переводить `PredefinedMenuItem` (Undo/Redo/Cut/Copy/Paste/Minimize/Maximize/Close) — это macOS native
- Не интерполировать локализованные строки в `v-html` (XSS-вектор)

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|---|---|---|---|
| First launch, sys RU | `beads:locale` absent, `navigator.language` = `"ru-RU"` | UI на RU | — |
| First launch, sys EN | `beads:locale` absent, `navigator.language` = `"en-US"` | UI на EN | — |
| First launch, sys DE/other | `beads:locale` absent, non-RU/EN | UI на EN (fallback) | — |
| Locale с регионом | `"ru-RU"`, `"ru"`, `"ru-BY"` | Резолвятся в `'ru'` через `.startsWith('ru')` | — |
| Explicit override | `beads:locale` = `"en"`, system = RU | UI на EN | — |
| Switch at runtime | Пользователь выбрал RU в Settings | UI реактивно, `setWindowTitle(t('app.title'))` обновляет title, нативное меню Tauri пересоздаётся | — |
| Reset to auto | Пользователь выбрал "Auto" | `beads:locale` = `null`, возврат к системной | — |
| Missing key in ru.json | `$t('x')` есть в EN, нет в RU | EN-текст | `logFrontend('warn', '[i18n] missing ru key: x')` в dev |
| Missing в обеих | Ключ отсутствует везде | Показать ключ | Warn в dev |
| Pluralization RU | `t('issues.count', 5)` | `"5 задач"`; `(1)` → `"1 задача"`; `(3)` → `"3 задачи"` | — |
| Pluralization EN | `t('issues.count', 5)` | `"5 issues"`; `(1)` → `"1 issue"` | — |
| Corrupt localStorage | `beads:locale` = `"garbage"` | Игнор, fallback на auto | — |
| localStorage disabled | `useLocalStorage` не работает | In-memory ref с auto, toast "Language preference won't persist" | — |

</frozen-after-approval>

## Code Map

**New files:**

- `i18n/locales/en.json` — english UI strings, nested по компоненту/фиче
- `i18n/locales/ru.json` — russian
- `i18n/locales/README.md` — правила: naming, что не переводим, fallback policy
- `app/composables/useLocale.ts` — wrapper над `useI18n()`, auto-detect, persist, rebuild Tauri menu on change
- `app/utils/date-format.ts` — `formatDate(date, locale)` через `Intl.DateTimeFormat` (заменит дубликаты)
- `tests/composables/useLocale.test.ts` — auto-detect, override, persist, reset, corrupt-localStorage
- `tests/utils/date-format.test.ts`

**Modified (infra):**

- `package.json` — `@nuxtjs/i18n` + lock file
- `nuxt.config.ts:33` — добавить модуль, strategy=`no_prefix`, defaultLocale=`en`, fallbackLocale=`en`, detectBrowserLanguage=`false`

**Modified (components):**

- `app/components/layout/*.vue` (9) — AppHeader, AboutDialog, DebugDialog, DebugPanel, SettingsDialog, UpdateDialog, UpdateIndicator, DialogsLayer, CollapsibleSection
- `app/components/dashboard/*.vue` (10) — KpiCard, OnboardingCard, PrerequisitesCard, PathSelector, FolderPicker, PinnedList, QuickList, PriorityChart, StatusChart, DashboardContent
- `app/components/details/*.vue` (4) — IssueDetailHeader, IssueForm, IssuePreview, CommentSection
- `app/components/issues/*.vue` (15) — toolbar, фильтры, колонки. Badge-компоненты — **только aria-label через `$t()`**, текст остаётся EN
- `app/components/ui/{confirm-dialog,notification-toast}/*.vue` — OK/Cancel/Confirm
- `app/composables/{useNotification,useAppMenu,useUpdateChecker}.ts` — runtime-строки; `useAppMenu` пересоздаёт меню при смене локали
- `app/pages/index.vue` — dialog titles, error messages
- `app/components/issues/IssueTable.vue:274-286`, `app/components/details/IssuePreview.vue:344-356` — заменить inline `formatDate` на импорт из `~/utils/date-format`

**Not modified:**

- `src-tauri/**` (scope: только UI)
- Badge content (bd-идентификаторы)
- `app/utils/bd-api.ts` (IPC остаётся EN)

## Tasks & Acceptance

**Execution:**

- [ ] `package.json`, `nuxt.config.ts` -- установить и сконфигурировать `@nuxtjs/i18n` -- инфраструктура. **Проверить совместимость с Nuxt 4 compatibilityVersion:4 перед фиксацией версии**
- [ ] `app/composables/useLocale.ts` + test -- single source of truth для языка
- [ ] `app/utils/date-format.ts` + test -- вынести formatDate, принимать locale
- [ ] `i18n/locales/{en,ru}.json` + `README.md` -- базовая структура: app, common, settings, dashboard, issues, details
- [ ] `app/components/layout/SettingsDialog.vue` -- секция "Language" с radio (Auto/English/Русский)
- [ ] `app/components/layout/*.vue` (9) -- обернуть строки, пополнить локали
- [ ] `app/components/dashboard/*.vue` (10)
- [ ] `app/components/issues/*.vue` (15) + aria-label для баджей
- [ ] `app/components/details/*.vue` (4)
- [ ] `app/components/ui/{confirm-dialog,notification-toast}/*.vue`
- [ ] `app/composables/{useNotification,useAppMenu,useUpdateChecker}.ts` — useAppMenu пересоздаёт меню на watch locale
- [ ] `app/pages/index.vue`
- [ ] Финальный проход по `en.json`/`ru.json` — полнота ключей, симметрия
- [ ] Manual QA через Tauri MCP — см. Verification

**Acceptance Criteria:**

- Given свежая установка, sys = `ru-RU`, when запуск, then UI на RU
- Given свежая установка, sys = `de-DE`, when запуск, then UI на EN (fallback)
- Given user выбрал "English" в Settings, when reload, then UI на EN независимо от системы
- Given user выбрал "Auto", when reload, then UI возвращается к системной
- Given смена языка в Settings, when без reload, then весь UI + title окна + нативное меню Tauri переключаются
- Given issue `status=open`, when смотрим `StatusBadge`, then text=`"open"` на любом языке, aria-label=`"Status: open"`/`"Статус: open"`
- Given `pnpm test && npx vue-tsc --noEmit`, then exit 0
- Given RAMS + web-interface-guidelines review, then нет critical
- Given `grep -rE ">\s*[А-Я][а-я]+|>\s*[A-Z][a-z]+\s*<" app/components | grep -v "\$t\|{{ t("`, then пусто

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Empty until the first bad_spec loopback. -->

## Design Notes

**Locale resolution (useLocale):**

1. `localStorage.getItem('beads:locale')` — если валидное (`'en'`/`'ru'`) → использовать
2. Иначе `navigator.language.startsWith('ru')` → `'ru'`, иначе `'en'`
3. Невалидные в localStorage игнорируются (fallback на шаг 2)

**RU plural rules (vue-i18n):**

```json
{ "issues": { "count": "нет задач | {count} задача | {count} задачи | {count} задач" } }
```

vue-i18n требует explicit `pluralRules` конфиг для `ru` — иначе применит английские правила и выдаст неверную форму.

**Rebuild меню Tauri:**
`useAppMenu` watches `useLocale().locale` — на изменение dispose старое меню, создаёт новое. Проверить отсутствие мигания menubar на macOS.

**Key naming:**

- `app.*` — глобальные (title, version)
- `common.*` — переиспользуемые (ok, cancel, confirm, delete)
- `<component>.<subcomponent>.<element>` — специфичные (e.g. `settings.language.title`)

## Verification

**Commands:**

- `pnpm test` -- все unit-тесты passed (+ новые)
- `npx vue-tsc --noEmit` -- 0 ошибок
- `grep -rE ">\s*[А-Я][а-я]+|>\s*[A-Z][a-z]+\s*<" app/components` -- только `$t()` и интерполяции, без хардкода
- Скрипт симметрии ключей EN/RU — оба JSON имеют одинаковый набор путей

**Manual checks (Tauri MCP):**

- Screenshot EN → RU → EN без рестарта; UI реактивно
- Очистить localStorage, сменить system language на RU в macOS, запуск → UI на RU
- Title окна меняется; нативное меню macOS обновляется (About/Settings/Check/Logs — локализованы, Edit/Window — остаются native)
