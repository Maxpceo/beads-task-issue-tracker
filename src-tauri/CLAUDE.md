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

`pnpm tauri:dev` runs `scripts/predev.sh` first — automatic pre-flight that:

1. Frees port 3133 if held by a stale Nuxt process from this repo (cwd check via `lsof`). Without this, a zombie Nuxt makes the new one fall back to 3000 while the Tauri webview still loads 3133 → blank window.
2. Kills zombie dev-binary copies, scoped to the full path `$REPO_ROOT/src-tauri/target/debug/beads-issue-tracker`. The installed `/Applications/Beads Task-Issue Tracker.app` is **not** affected — both binaries share the same executable name (`beads-issue-tracker` from the Cargo crate), so a bare `pkill -f "beads-issue-tracker"` would close it.
3. Refuses to act if port 3133 is held by a foreign process — exits with a clear message instead of guessing.

If you ever need to kill the dev binary by hand, scope the match to the full path:

```bash
pkill -f "$(pwd)/src-tauri/target/debug/beads-issue-tracker"
```

## File Watcher Coalescing

The Rust backend coalesces high-frequency filesystem events into infrequent `beads-changed` IPC events before they reach the frontend. Two layers of rate-limiting are applied.

### Constants (lib.rs:213–221)

| Constant / env var | Default | Description |
|--------------------|---------|-------------|
| `WATCHER_DEBOUNCE_INTERVAL_MS` | 1000 ms | `notify_debouncer_mini` accumulates raw OS fs-events for this window before delivering a batch. |
| `WATCHER_MIN_EMIT_INTERVAL_MS_DEFAULT` | 2000 ms | Minimum gap between consecutive `beads-changed` emits. Override via `WATCHER_MIN_EMIT_INTERVAL_MS` env var (floor: 250 ms). |

Net effect: a burst of CLI writes spread over <2 s typically produces **one** `beads-changed` event to the frontend.

### Decision logic (lib.rs:5327–5403)

Each debounced batch is processed as follows:

1. **Filter**: `should_process_watcher_event()` (lib.rs:228–246) accepts only `DebouncedEventKind::Any | AnyContinuous` inside `.beads/`. Excluded: `.dolt/stats/`, `.dolt/tmp/`, `.dolt/.tmp/`, and files ending in `.lock`, `.tmp`, `.swp`, `~`.
2. **Skip if 0 relevant events** in the batch — no emit, no state update.
3. **Emit immediately** if `elapsed_since_last_emit >= min_interval` (or no prior emit this session).
4. **Suppress + schedule flush** otherwise: `pending=true`, `suppressed_batches += 1`, spawn `schedule_pending_watcher_emit()` once (guarded by `flush_scheduled` flag).

### Starvation guard — `schedule_pending_watcher_emit` (lib.rs:259–317)

A background thread polls every 50 ms. When `min_interval` has elapsed and `pending` is still set, it fires `beads-changed` and logs `Delayed coalesced emit`. This guarantees an emit after any finite burst, regardless of how many batches were suppressed.

### Emit semantics

`beads-changed` carries only `{ path: project_path }` (lib.rs:249–257). The frontend (`useChangeDetection.ts`) responds by **re-fetching the entire project** from the JSONL source. Intermediate states during a burst are never delivered — the frontend always sees the final consistent state. There is no "middle-state loss" risk.

### beads.log counter legend

All three log lines share the same counter set. Counters are **per-session totals** (reset on each `start_watching` call):

| Counter | Meaning |
|---------|---------|
| `events` | Total OS fs-events in the current debounced batch |
| `relevant` | Events that passed `should_process_watcher_event()` |
| `emitted` | Cumulative successful `beads-changed` emits this session |
| `suppressed` | Cumulative batches held back (min-interval not elapsed) |

Log line examples:
- `Emitted coalesced update` — immediate emit path
- `Suppressed watcher batch` — min-interval not elapsed; flush scheduled
- `Delayed coalesced emit` — starvation-guard fired after cooldown

### Singleton + session ID (lib.rs:172–187)

`WatcherState` is a single Tauri-managed mutex. `watch_session_id` increments on every `start_watching` call; stale flush-threads from prior sessions self-terminate when they see a mismatched `session_id`. Only one project path can be watched at a time — starting a new watch stops the previous one.

### Interaction with TS-side cooldown

Frontend `SELF_TRIGGER_COOLDOWN_MS` (500 ms, `useChangeDetection.ts`) guards against mtime-echo from the app's own `bdCheckChanged()` polls. These two layers are independent: Rust coalesces bursts before the event reaches TS; the TS cooldown suppresses self-triggered re-polls.

When `useChangeDetection` handles a `beads-changed` watcher event it calls `pollForChanges({ skipMtimeCheck: true })`. This bypasses the `LAST_KNOWN_MTIME` gate in `bd_poll_data` and removes the cached `POLL_MEMO` entry for the project before spawning `bd list`. The fix ensures that Dolt's 5-second auto-flush window (which writes to `.dolt/*` before updating `issues.jsonl`) no longer causes watcher-triggered polls to see stale mtime data and silently skip the fetch. Additionally, `bd_poll_data` now snapshots the file mtime **before** spawning `bd list` (entry-time mtime), so external writes that land during the subprocess window are not masked as "already seen" in subsequent polls. Self-write mtime-echo suppression via `SELF_TRIGGER_COOLDOWN_MS` remains intact — it applies only after local CRUD operations, not after every poll cycle.

## AI-Driven UI Testing (Tauri MCP)

Chrome DevTools / Playwright **do not work with Tauri's WKWebView on macOS** — Apple does not implement CDP. To let Claude Code drive the running app (DOM, screenshots, clicks, JS exec, native mac mouse/keyboard), the project ships [`tauri-plugin-mcp`](https://github.com/P3GLEG/tauri-plugin-mcp) gated behind the `dev-mcp` Cargo feature (see `src-tauri/Cargo.toml` `[features]` and `#[cfg(feature = "dev-mcp")]` in `src-tauri/src/lib.rs` `setup()`). `pnpm tauri:dev` passes `--features dev-mcp`; `tauri build` does not, so release binaries omit the plugin.

To use it locally:

1. Install the MCP-server bridge once: `npm i -g tauri-plugin-mcp-server`. Note: this npm package's `bin` is shipped as a JS file with **no shebang**, so we cannot exec it directly — `.mcp.json` invokes it via `node` with the full `index.js` path (already wired).
2. Start the app: `pnpm tauri:dev` (the plugin auto-starts inside the dev binary; the Rust side is configured to bind to literal `/tmp/tauri-mcp.sock` because the npm bridge hard-codes that path and ignores `$TMPDIR`).
3. `.mcp.json` exposes the MCP server (already wired — `command: "node"`, `args: ["/opt/homebrew/lib/node_modules/tauri-plugin-mcp-server/build/index.js"]`). Verify with `claude mcp list` — expect `tauri: ✓ Connected`. If you see `Failed to connect`, check that `/tmp/tauri-mcp.sock` exists (the dev binary creates it at startup).
4. Ask Claude things like: "Take a screenshot of the app", "Click the Type filter and tell me the options", "Read the contents of localStorage key `beads:proj:*`".

Verification examples for upcoming features should prefer this over asking the human to look at the screen.
