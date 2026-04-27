# i18n/locales

User-facing interface strings for Beads Task-Issue Tracker.

## Supported locales

- `en.json` — English (default and fallback)
- `ru.json` — Russian

## Key naming convention

Nested by domain, dot-separated in code:

```
<namespace>.<subnamespace?>.<element>
```

| Namespace | Scope |
|-----------|-------|
| `app`     | Global app metadata (title, version) |
| `common`  | Reusable primitives (ok, cancel, save, delete, loading, error, …) |
| `settings`| SettingsDialog and its subsections (language, theme, etc.) |
| `dashboard` | Left sidebar dashboard content (KPIs, project picker, onboarding) |
| `issues`  | Issue table, toolbar, filters, badges, columns |
| `details` | Right sidebar issue detail/preview/edit forms |

Examples:

- `common.ok` → "OK" / "ОК"
- `settings.language.auto` → "Auto" / "Авто"
- `issues.filters.clearAll` → (future) "Clear all filters" / "Сбросить фильтры"

## Usage in Vue

```vue
<script setup>
const { t } = useI18n()
</script>

<template>
  <button>{{ t('common.ok') }}</button>
  <!-- or shorthand -->
  <button>{{ $t('common.ok') }}</button>
</template>
```

## Fallback policy

- `fallbackLocale: 'en'` — if a key is missing in `ru.json`, the English text is shown.
- Invalid/absent `localStorage['beads:locale']` values resolve to system locale via `navigator.language` (see `app/composables/useLocale.ts`).
- Missing keys log a `logFrontend('warn', '[i18n] missing key: …')` only in dev; production fails silently.

## What NOT to translate

These intentionally stay in their source form across both locales:

1. **bd identifiers** — statuses (`open`, `in_progress`, `blocked`, `closed`, `deferred`, `pinned`, `hooked`, `inreview`, `simplified`, `reviewed`, `accepted`), types (`bug`, `task`, `feature`, `epic`, `spike`, `story`, `milestone`), priorities (`P0`–`P4`). Badge components (`StatusBadge`, `TypeBadge`, `PriorityBadge`) render these as-is on any locale.
2. **User content** — issue `title`, `description`, comments, labels, assignee names. Data from the user's beads database is never translated.
3. **Rust backend output** — log messages from `log_info!`/`log_error!` and error strings returned from Tauri commands. Out of scope for this i18n layer — if needed later, that's a separate epic.
4. **Native macOS menu items** controlled by `PredefinedMenuItem` (Undo/Redo/Cut/Copy/Paste/Minimize/Maximize/Close). macOS owns these.

## Adding new keys

1. Add to `en.json` first (source of truth for shape).
2. Mirror to `ru.json` with translation. Keep the exact same nested structure.
3. Reference in Vue as `$t('your.new.key')`.
4. If the key needs a count variable (pluralization), see the Russian pluralization notes in the i18n spec (`_bmad-output/implementation-artifacts/spec-i18n-en-ru-ui.md` → Design Notes).

## Keeping locales in sync

Both files must have the **same set of keys**. Use `jq` to diff key paths:

```sh
diff <(jq -r 'paths | join(".")' i18n/locales/en.json | sort) \
     <(jq -r 'paths | join(".")' i18n/locales/ru.json | sort)
```

Empty output = locales in sync. A CI check for this may land as a later i18n hygiene task.
