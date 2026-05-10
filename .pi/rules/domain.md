# Pi Domain Rules

These are Pi-native project rules distilled from Claude reference files. Do not modify `.claude/*` for Pi workflow changes.

## Logging

- Do not use `console.*` in `app/` except the console-to-log interceptor.
- Frontend logging uses `logFrontend(level, '[context] message')` from `~/utils/bd-api` and should append `.catch(() => {})`.
- Rust logging uses `log_info!`, `log_warn!`, `log_error!`, `log_debug!`; debug requires verbose logging flags.
- User-visible logs must reach the app log (`beads.log`), not only DevTools.

## Locale sync

- UI strings in Vue/templates use `$t('namespace.key')`; TS/composables use `useI18n().t()`.
- Add/remove/rename keys in `i18n/locales/en.json` and `i18n/locales/ru.json` together.
- Do not translate user-authored bead content, bd identifiers, file/function names, or native macOS menu labels.
- Check key parity with: `jq -S 'paths(scalars)' i18n/locales/en.json i18n/locales/ru.json | diff -`.

## UI constraints / frontend review

- Use existing component primitives and accessible semantics; icon-only controls need labels.
- Keyboard access, focus visibility, contrast, reduced motion, responsive layout, touch target size, and non-color-only states are review requirements.
- Prefer Tailwind defaults and existing theme tokens; avoid arbitrary z-index, gradients, glow effects, and layout-property animation unless explicitly requested.
- Pi frontend review uses the explicit Pi Frontend Review Checklist from `beads-task-issue-tracker-vzwo`; do not require undefined RAMS/WIG tools.

## src-tauri / bd compatibility

- Backend must support both legacy JSONL and Dolt-backed bd projects; use version-gated helpers before relying on bd features.
- bd 0.57+ self-manages Dolt server and auto-flush/import; do not assume manual server lifecycle.
- File watcher logic intentionally coalesces `.beads/` events before frontend refetches; preserve debounce/min-emit semantics when editing watcher code.
- Recommended dev startup is `./start-dev.sh`; it handles port 3133 and stale dev binaries safely.
