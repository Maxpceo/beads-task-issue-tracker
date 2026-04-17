# src-tauri/ — Rust backend

Tauri v2 backend: IPC commands, bd CLI bridge, logging, Dolt sync. Frontend lives in `../app/` (Nuxt/Vue).

## bd Version Compatibility

- **The app works with any bd version** — the Rust backend auto-detects the installed bd version via `parse_bd_version()` and adapts behavior through version-gated helpers (`supports_daemon_flag()`, `uses_jsonl_files()`, `supports_list_all_flag()`, `supports_delete_hard_flag()`, `uses_dolt_backend()`, `project_uses_dolt()`). All helpers handle both `major == 0` (pre-1.0) and `major >= 1` (1.x+) correctly.
- **bd 0.57+ uses a self-managing Dolt server** — `dolt sql-server` starts automatically on first command, no manual lifecycle management needed. This resolved the regressions from bd 0.50–0.56 that we reported in [upstream issue #2050](https://github.com/steveyegge/beads/issues/2050) (now closed/fixed).
- **JSONL stays in sync automatically** — bd 0.57+ has auto-flush (Dolt → `issues.jsonl` after each mutation, 5s debounce) and auto-import (JSONL → Dolt when file is newer). No manual export or sync hooks needed.
- **`bd sync` no longer exists** — replaced by auto-flush/auto-import and `bd export`/`bd import`. Session Completion step uses `bd dolt push` if Dolt remote is configured; otherwise JSONL is committed with git.
- **The branch `feat/bd-056-server-mode`** is obsolete — its work (server mode detection, adaptive polling, DoltServerBanner) was superseded by bd's native self-managing server. The branch can be deleted.

## bd Backward Compatibility

- Never assume all projects use Dolt — check `project_uses_dolt()` before skipping legacy paths
- Use version-gated helpers in `src-tauri/src/lib.rs` for any feature that depends on a specific bd version
- When adding new version-gated behavior, ensure both `major == 0` and `major >= 1` paths are covered

## Logging (Rust)

Use `log_info!("[context] message")`, `log_error!(...)`, `log_warn!(...)`, `log_debug!(...)` macros — they write directly to the native log. `log_debug!` requires both `LOGGING_ENABLED` and `VERBOSE_LOGGING` env flags.

Full logging rules (frontend + backend + log-file paths): `.claude/rules/logging.md`.

## Dev Server

Always kill zombies before starting:

```bash
pkill -f "$(pwd)/src-tauri/target/debug/beads-issue-tracker" 2>/dev/null && pnpm tauri:dev
```

**Note:** scope the `pkill` match to the dev binary path. A bare `pkill -f "beads-issue-tracker"` also kills the installed `/Applications/Beads Task-Issue Tracker.app` because both binaries share the same executable name (`beads-issue-tracker` from the Cargo crate).

## AI-Driven UI Testing (Tauri MCP)

Chrome DevTools / Playwright **do not work with Tauri's WKWebView on macOS** — Apple does not implement CDP. To let Claude Code drive the running app (DOM, screenshots, clicks, JS exec, native mac mouse/keyboard), the project ships [`tauri-plugin-mcp`](https://github.com/P3GLEG/tauri-plugin-mcp) gated behind the `dev-mcp` Cargo feature (see `src-tauri/Cargo.toml` `[features]` and `#[cfg(feature = "dev-mcp")]` in `src-tauri/src/lib.rs` `setup()`). `pnpm tauri:dev` passes `--features dev-mcp`; `tauri build` does not, so release binaries omit the plugin.

To use it locally:

1. Install the MCP-server bridge once: `npm i -g tauri-plugin-mcp-server`. Note: this npm package's `bin` is shipped as a JS file with **no shebang**, so we cannot exec it directly — `.mcp.json` invokes it via `node` with the full `index.js` path (already wired).
2. Start the app: `pnpm tauri:dev` (the plugin auto-starts inside the dev binary; the Rust side is configured to bind to literal `/tmp/tauri-mcp.sock` because the npm bridge hard-codes that path and ignores `$TMPDIR`).
3. `.mcp.json` exposes the MCP server (already wired — `command: "node"`, `args: ["/opt/homebrew/lib/node_modules/tauri-plugin-mcp-server/build/index.js"]`). Verify with `claude mcp list` — expect `tauri: ✓ Connected`. If you see `Failed to connect`, check that `/tmp/tauri-mcp.sock` exists (the dev binary creates it at startup).
4. Ask Claude things like: "Take a screenshot of the app", "Click the Type filter and tell me the options", "Read the contents of localStorage key `beads:proj:*`".

Verification examples for upcoming features should prefer this over asking the human to look at the screen.
