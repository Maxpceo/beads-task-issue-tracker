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

## Frontend code organization

- Keep `app/pages/index.vue` as an orchestrator only: layout structure, composable wiring, and minimal glue code.
- Extract stateful logic into `app/composables/`, pure logic into `app/utils/`, and UI sections into dedicated `app/components/` files.
- Prefer shared components over duplication, especially for repeated controls, dialogs, filters, and table/list UI.
- Pure logic in `app/utils/` should have matching tests under `tests/` when added or materially changed.

## Testing

- Run `pnpm test` before committing code changes when relevant; use `pnpm test:watch` for local iteration.
- Run `npx vue-tsc --noEmit` for TypeScript/Vue type-safety checks when app TypeScript or Vue files change.
- Tests should mirror `app/` structure where practical, for example `tests/utils/example.test.ts` for `app/utils/example.ts`.
- For docs/config/beads-only changes, record an explicit skipped reason instead of implying tests passed.

## src-tauri / bd compatibility

- Backend must support both legacy JSONL and Dolt-backed bd projects; use version-gated helpers before relying on bd features.
- bd 0.57+ self-manages Dolt server and auto-flush/import; do not assume manual server lifecycle.
- Do not run or document `bd sync`; that command no longer exists in bd 0.57+. Use `bd dolt pull` / `bd dolt push` for Dolt-backed projects, or explicit named `.beads/` git paths for legacy JSONL projects.
- Use version-gated helpers in `src-tauri/src/lib.rs` for bd CLI behavior; cover both pre-1.0 and 1.x+ paths.
- Rust logging should use project macros (`log_info!`, `log_warn!`, `log_error!`, `log_debug!`), not `println!` for app logging.
- File watcher logic intentionally coalesces `.beads/` events before frontend refetches; preserve debounce/min-emit semantics when editing watcher code.
- Recommended dev startup is `./start-dev.sh`; it wraps `pnpm tauri:dev`, handles port 3133, clears stale dev state, and avoids killing installed app binaries.
- Chrome DevTools/Playwright do not drive macOS Tauri WKWebView directly; use project-supported Tauri MCP/manual evidence where UI automation is needed.
