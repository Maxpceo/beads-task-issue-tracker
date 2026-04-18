---
name: logging
description: Never use console.* in app/; use logFrontend() for TS and log_* macros for Rust. DevTools disabled in release builds.
paths:
  - "app/**/*.ts"
  - "app/**/*.vue"
  - "src-tauri/src/**/*.rs"
---

# Logging

- **Never use `console.*`** in `app/` — the only exception is `app/plugins/console-to-log.client.ts` (the interceptor itself).
- **Why**: In Tauri release builds, DevTools are disabled. The only user-facing log viewer is the in-app DebugPanel (Cmd+L), which reads `beads.log` via the Rust backend. Any `console.*` output is invisible to the end user.

## Frontend (TypeScript)

`logFrontend(level, '[context] message')` — import from `~/utils/bd-api`. Calls the Rust `log_frontend` Tauri command.

- Levels: `'error'`, `'warn'`, `'info'`, `'debug'`
- `'debug'` is gated by the Verbose toggle in DebugPanel — messages only appear in `beads.log` when Verbose is ON. Use for high-frequency diagnostics with rate-limiting.
- Always append `.catch(() => {})` — if IPC is broken, fail silently (the app is likely broken anyway).

## Backend (Rust)

`log_info!("[context] message")`, `log_error!(...)`, `log_warn!(...)`, `log_debug!(...)` macros — write directly to the native log. `log_debug!` requires both `LOGGING_ENABLED` and `VERBOSE_LOGGING`.

## Log file (per platform)

- **macOS**: `~/Library/Logs/com.beads.manager/beads.log` — readable via `tail -f` or in the app.
- **Linux**: `~/.local/share/com.beads.manager/logs/beads.log` (XDG, matches `tauri-plugin-log`)
- **Windows**: `%APPDATA%/com.beads.manager/logs/beads.log`
