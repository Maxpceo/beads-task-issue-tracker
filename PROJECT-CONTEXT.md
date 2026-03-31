# Project Context for AI Agents

_Критические правила для AI агентов. Детали — в CLAUDE.md._

---

## Стек

- **Frontend:** Nuxt 4.3 + Vue 3.5 + Tailwind CSS v4.1 + shadcn-nuxt
- **Backend:** Tauri 2.9.5 (Rust)
- **Тесты:** Vitest 4.0 (jsdom)
- **PM:** pnpm 10.0
- **Issue Tracking:** bd (beads) 0.49.x — встроенный Dolt, НЕ обновлять до 0.50+

---

## CRITICAL RULES

### 1. DRY — НИКАКОГО ДУБЛИРОВАНИЯ

- `app/composables/` — переиспользуемая логика (state, dialogs, resize, filtering)
- `app/utils/` — чистые функции (для тестируемости)
- `app/components/` — переиспользуемые UI-компоненты
- **Никогда** не дублировать бизнес-логику между компонентами — выносить в composables/utils

### 2. Naming Conventions

- **TypeScript/Vue:** camelCase для переменных и функций, PascalCase для компонентов и типов
- **Rust:** snake_case для функций и переменных, PascalCase для типов и структур
- **Tauri commands:** snake_case (Rust) ↔ camelCase (TS вызов через `invoke`)
- **CSS:** Tailwind utility classes, CSS variables для тем

### 3. Русский язык — комментарии и UI

### 4. No Silent Fallbacks — ошибка лучше неверных данных

Приложение **НИКОГДА** не должно тихо подставлять значения по умолчанию для критических параметров. Если данные не получены — показать ошибку пользователю.

### 5. Логирование

- **Никогда `console.log`** — только `logFrontend('info', '[context] message')` (из `~/utils/bd-api`)
- **Rust:** `log_info!("[context] message")`, `log_error!(...)`
- **Лог-файл:** `~/Library/Logs/com.beads.manager/beads.log`

---

## Anti-Patterns

| Не делать | Делать |
|-----------|--------|
| `console.log` | `logFrontend()` из `~/utils/bd-api` |
| Логика в `app/pages/index.vue` | Выносить в `app/composables/` |
| `any` в TypeScript | Конкретные типы из `app/types/` |
| Inline styles | Tailwind CSS utility classes |
| Дублирование UI-элементов | Shared components в `app/components/` |
| Прямые вызовы bd CLI из frontend | Через Tauri commands (`src-tauri/src/`) |

---

## Project Structure

| Что | Где |
|-----|-----|
| Компоненты UI | `app/components/` (shadcn в `app/components/ui/`) |
| Страницы (роутинг) | `app/pages/` |
| Composables (логика) | `app/composables/` |
| Чистые утилиты | `app/utils/` |
| Типы TypeScript | `app/types/` |
| Rust backend | `src-tauri/src/` |
| Tauri конфиг | `src-tauri/tauri.conf.json` |
| Тесты (Vitest) | `tests/` (зеркалит структуру `app/`) |
| Статические файлы | `public/` |

---

## UI/UX

- **Tailwind CSS v4.1** — utility-first, CSS variables для тем
- **shadcn-nuxt** — компоненты в New York стиле, neutral base color
- **Lucide Vue Next** — иконки
- **Dark mode** — через CSS variables (автоматически)
- **Keyboard navigation** — поддержка через shadcn accessibility

**Чеклист при работе с UI:**
1. CSS variables вместо hardcoded цветов
2. Dark mode поддержка (CSS variables)
3. Mobile responsive (хотя десктоп — основная платформа)
4. Accessibility (keyboard, ARIA — через shadcn)

---

## Documentation Standards

**TypeScript:**
- Интерфейсы и их поля — JSDoc `/** */`
- Экспортируемые функции/хуки — JSDoc с описанием параметров

**Rust:**
- Публичные функции и структуры — `///` doc comments
- Tauri commands — `///` с описанием что делает команда

**Общие правила:**
- Язык документации: русский (кроме технических терминов)
- Inline-комментарии: только где логика не очевидна
