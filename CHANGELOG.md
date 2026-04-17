# Changelog

## [Unreleased]

### Added
- **Dynamic statuses from `bd statuses`** (bd 1.0.x custom statuses): the app no longer hardcodes a 7-status whitelist — it loads the full list (built-in + custom) from `bd statuses --json` at startup and renders any status the database reports. Built-in badges (`OPEN`, `IN PROGRESS`, `BLOCKED`, `DEFERRED`, `CLOSED`, `PINNED`, `HOOKED`) keep their existing per-status gradients for visual continuity; custom statuses are styled by their category (`active`, `wip`, `frozen`, `done`) via four new `bg-status-category-*-gradient` CSS classes with per-theme overrides (default/light/flat/neon). Previously, any status outside the whitelist — including the bd 1.0.2 review chain (`inreview`, `simplified`, `reviewed`, `accepted`) — was silently rewritten to `open` in the Rust layer (`normalize_issue_status`) and lost. Now `issue.status === 'inreview'` is a real value end-to-end, the status filter dropdown lists every status defined in the database, and the `IssueStatus` TS type was widened from a closed union to `BuiltInStatus | (string & {})`. New Tauri command `bd_statuses(options: CwdOptions)` + new `useStatuses` composable with per-path reactive cache
- **Per-status color overrides in Settings** (Status Colors section in `SettingsDialog`): users can now pick a custom colour (solid or two-stop gradient) for any status via two `<input type="color">` pickers and a gradient toggle checkbox. Changes apply instantly to every badge in the app and are persisted per-project via `useLocalStorage('beads:proj:<hash>:status-colors', {})`. A Reset button clears the override and returns the badge to its default category colour. Useful when the default wip-category gradient makes custom statuses (`inreview`/`simplified`/`reviewed`/`accepted`) indistinguishable. Local-only: overrides do not sync between machines or teammates — synchronisation via `bd kv` is reserved as a follow-up if demand emerges. Covered by 15 new unit tests
- **`spike` / `story` / `milestone` issue types** (bd 1.0.0+ compat): bd 1.0.0 promoted these three to first-class types ([upstream PR #2923](https://github.com/gastownhall/beads/pull/2923)). The app now extends `IssueType` from 5 to 8 values across the Vue frontend (`TypeBadge`, `TypeFilterDropdown`, `ExclusionFilterDropdown`, `IssueForm`, `IssueTable`, `useFilters`, dashboard `byType` counters) and the Rust backend (`normalize_issue_type` validator + `bd_count` HashMap init). Each new type has its own muted-style badge with an inline SVG icon, is selectable from the create form, and survives CLI→UI round-trips
- **`started_at` timestamp on issues** (bd 1.0.1+ compat): bd 1.0.1 added `started_at` — the timestamp of the first transition into `in_progress` ([upstream PR #3206](https://github.com/gastownhall/beads/pull/3206), GH#2796). The app now parses the field in both the server transformer (`server/utils/bd-transformers.ts`) and the Rust `transform_issue`, exposes it as `Issue.startedAt?: string \| null`, and renders a "Started" block in `IssuePreview.vue` between Created and Updated. The block is hidden via `v-if` when null/undefined (no "Started: —" placeholder), so issues from older bd versions and brand-new tasks still render cleanly. 3 new unit tests for the parsing path
- **Hide `gt:slot` system beads**: The internal `merge-slot` service bead (tagged `gt:slot`) is now hidden from the issue table and excluded from dashboard KPI counts by default — it no longer clutters the task list or inflates Open/All stats.
- **`'debug'` log level for `logFrontend()`**: Gated by Verbose toggle in DebugPanel — enables high-frequency pipeline diagnostics in release builds. Rust backend uses `log::info!` with `[DEBUG]` tag (bypasses release `LevelFilter::Info`) when `VERBOSE_LOGGING` is active

### Fixes
- **`gt:slot` migration now runs per-project** (was one-shot global): the original migration from `7l1` (hide `gt:slot` system beads from the issue list and dashboard stats by default) relied on a single global localStorage flag `beads:system-labels-exclusion-migrated`. But `exclusionFilters` are stored per-project (`beads:proj:<hash>:exclusionFilters`) — so the migration ran once for whichever project happened to be active at first launch, set the global flag, and never re-ran. Every other project kept `labels: []`, leaving `gt:slot` beads visible forever. Moved the migration to a module-level `watch(beadsPath, ..., { immediate: true })` in `app/composables/useExclusionFilters.ts` (matching the pattern in `useStatuses.ts`). Each project now migrates independently on its first open via a per-project flag `beads:proj:<hash>:system-labels-migrated`. Added a one-time v2 upgrade (`beads:system-labels-migration-v2`) that deletes the old global flag on first load of the new code so per-project migration runs fresh for every project after the upgrade. User's explicit removal of `gt:slot` via the Exclusions UI is now preserved — the per-project flag guards re-run. 11 new unit tests cover fresh install, v1→v2 upgrade, user-choice respect, project switch, switch-back with cleared labels, and `perProjectMigrationKey` stability
- **Auto-chmod `.beads/` to `0700`** (bd 1.0.0+ compat): bd 1.0.0 enforces `0700` permissions on `.beads/` and prints a warning to stderr on every command if the directory has wider permissions ([upstream commit 047e506](https://github.com/gastownhall/beads/commit/047e506)). The app now silently sets `0700` on `.beads/` before every `execute_bd()` call via a new `ensure_beads_permissions()` helper in `src-tauri/src/lib.rs`. Idempotent (early return when already 0700), Unix-only via `#[cfg(unix)]`, Windows is a no-op. Errors are logged via `log_warn!` and never crash the app — so the upstream warning no longer spams DebugPanel and beads.log
- **Hook bugs that broke the orchestrator across sessions**: (1) `remind-simplify-after-supervisor.sh:30` showed `subagent_type="code-simplifier"` in its embedded Task() snippet, but the actual plugin name is `code-simplifier:code-simplifier` — orchestrator copied the wrong name and dispatch failed with "agent type not found" until manually corrected; (2) `enforce-branch-before-edit.sh` used `git branch --show-current` from the shell cwd (always pointed at the main repo, not the active worktree), so edits inside out-of-tree worktrees like `../bd-perms` were blocked because the main repo was on `main`. Now uses `git -C "$(dirname FILE_PATH)"` so each edit is checked against the branch of the file's actual repo, supporting git worktrees anywhere
- **`start-dev.sh` misdetects own zombies as foreign processes**: When Nuxt leaves an orphan `node ... nuxt.mjs dev` on port 3000, its argv contains a relative path (`./node_modules/.bin/../.pnpm/...`), so the old `ps -o command | grep $PROJECT_ROOT` never matched and the script exited with "порт занят процессом из другого проекта", forcing a manual `kill`. Now the port-conflict check compares the process's `cwd` (`lsof -a -d cwd -p $PID -Fn`) against `$PROJECT_ROOT` — an unambiguous kernel attribute independent of argv formatting. The installed app stays safe: it uses the `app://` custom protocol (does not listen on 3000/3133) and its `cwd` is never `$PROJECT_ROOT`
- **Replace all `console.*` calls with `logFrontend()`**: 35 violations across 16 frontend files now use the native Tauri logging pipeline instead of `console.error`/`warn`/`debug`. Errors and warnings now appear in the in-app DebugPanel log viewer, making them visible to end users who have no DevTools access in release builds
- **Gate `tauri-plugin-mcp` behind a proper Cargo feature** (`dev-mcp`): `src-tauri/Cargo.toml` previously declared the plugin under `[target.'cfg(debug_assertions)'.dependencies]`, which Cargo explicitly warns does not work — `cfg(debug_assertions)` is unsupported for conditional dependencies, so the plugin (plus ~MB of transitive crates: `enigo`, `image`, `tungstenite`) was silently linked into **release** binaries too. The runtime `#[cfg(debug_assertions)]` guard in `lib.rs` kept the IPC socket from starting in release, but the dead code still shipped — and any accidental reference to plugin symbols outside a `cfg` gate would have compiled into the production build. Now declared as an `optional = true` dependency plus a `[features]` section (`dev-mcp = ["dep:tauri-plugin-mcp"]`). The registration block in `lib.rs` is gated by `#[cfg(feature = "dev-mcp")]`, and `pnpm tauri:dev` passes `--features dev-mcp`; `tauri build` does not, so release binaries no longer contain the plugin at all. Verified: `cargo tree --release` no longer lists `tauri-plugin-mcp`, and the `debug_assertions` warning is gone from `cargo build --release`
- **Tauri MCP plugin wiring** (`.mcp.json` + `src-tauri/src/lib.rs`): three independent issues stopped Claude Code from ever connecting to the in-app MCP server, so visual QA silently fell back to "ask the human to look at the screen". (1) `.mcp.json` referenced binary `tauri-plugin-mcp-server`, but the npm package installs the binary as `tauri-mcp-server` (no `-plugin-` segment). (2) The npm-shipped binary is a JavaScript file with no `#!/usr/bin/env node` shebang — `posix_spawn` of a bare `tauri-mcp-server` fails with `ENOEXEC`. We now invoke it explicitly: `command: "node", args: ["/opt/homebrew/lib/node_modules/tauri-plugin-mcp-server/build/index.js"]`. (3) `tauri_plugin_mcp::init()` defaults the IPC socket path to `std::env::temp_dir()` (= `$TMPDIR`, e.g. `/var/folders/.../T/`), but the npm bridge hard-codes its connect path to literal `/tmp/tauri-mcp.sock` (per upstream comment in `client.js`: "The Tauri app and MCP server run as separate processes with different TMPDIR values"). We now call `init_with_config` with an explicit `socket_path("/tmp/tauri-mcp.sock")` so both sides agree. The "AI-Driven UI Testing" section in `CLAUDE.md` is updated accordingly
- **Cross-platform log path and PATH resolution** (upstream #15): `get_log_path()` was hardcoded to the macOS `~/Library/Logs/` layout, so on Linux the UI showed an empty log file and on Windows the path became a broken relative string (no `HOME` variable). `get_extended_path()` used Unix-only directories and the `:` separator, which mangled any Windows `C:\…` entry and prevented Tauri commands from locating `bd`/`br`. Both functions are now branched via `#[cfg(target_os = …)]`: macOS keeps `~/Library/Logs/com.beads.manager/beads.log`; Linux uses `dirs::data_local_dir()` → `~/.local/share/com.beads.manager/logs/beads.log` (matches `tauri-plugin-log` XDG layout); Windows uses `dirs::data_dir()` → `%APPDATA%/com.beads.manager/logs/beads.log` plus `USERPROFILE`/`LOCALAPPDATA`-based extra bin paths with the `;` PATH separator. Port of upstream `w3dev33/beads-task-issue-tracker` commit `a24eddf9` (v1.24.3)

- **Filters now persist across project switches and reload** (`beads-task-issue-tracker-97o`): `useFilters()` had a force-reset block that ran on every call and overwrote `status` with the workflow defaults (`open + in_progress + deferred + pinned + hooked`) plus cleared `search`/`labels`/`assignee`, ignoring whatever the user had previously stored in `localStorage`. So clearing filters in project A and switching B → A would silently revert A back to the workflow view instead of keeping the empty state. The workflow defaults are now expressed as `defaultFilters` and applied **only on first visit** when no value exists for the project (`useProjectStorage` semantics) — explicit user state survives navigation, project switches, and full reload. The KPI Workflow card already provides a one-click way to restore the defaults, so the implicit auto-reset was redundant. Best-practice alignment: Linear, Tableau, Salesforce, and other workspace-scoped filter UIs preserve last state by default and apply defaults only when nothing is stored. Side-effect fix in `useProjectStorage.loadValue`: `defaultValue` is now deep-cloned before being returned, so mutating `filters.value.status = []` in one project no longer leaks into the shared `defaultFilters` object and contaminates the next project's load. 5 new integration tests cover fresh install (workflow default), reload survival of cleared state, A→B→A round-trip, search/labels/assignee persistence, and `hasActiveFilters` reactivity

### Tests
- **Integration test for `useExclusionFilters` migration** (`beads-task-issue-tracker-jq9`): the existing suite reimplemented `SYSTEM_LABELS`, the v1/v2 flag names, `perProjectMigrationKey`, `upgradeV1FlagIfNeeded`, and `runMigration` as local pure functions — so a change to production migration logic (e.g. adding a new system label) would have left the tests green while the real composable drifted. Rewritten to import `useExclusionFilters` and `useBeadsPath` directly, use `vi.resetModules()` + `await import(...)` per test to re-execute the module-level `watch(beadsPath, ..., { immediate: true })` that actually drives the migration, and install a fresh in-memory `Storage` stub per test (same pattern as the `useStatusColorOverrides` suite). 7 tests cover fresh install, v1→v2 flag upgrade, user-choice-respected, no-duplication, project switch via `setPath`, switch-back after user cleared `gt:slot`, and `activeCount`/`hasActiveExclusions` reactive state. Required adding explicit `import { ref, watch, readonly, computed } from 'vue'` to `app/composables/useBeadsPath.ts` and extending the existing Vue import in `app/composables/useExclusionFilters.ts` with `computed` — both composables previously relied on Nuxt auto-imports that are absent under Vitest
- **Integration test for `useStatusColorOverrides`** (`beads-task-issue-tracker-mmw`): the existing test file reimplemented the style formula and an abstract store instead of importing the real composable, so the claimed `beads:proj:<hash>:status-colors` key format and `useProjectStorage` integration were never verified. Rewritten to import `useStatusColorOverrides` and `clearProjectStorageCache`/`reloadProjectStorage` directly and exercise them against a fresh in-memory `Storage` stub per test (Node 25's built-in `localStorage` broke jsdom's Storage prototype — `.clear` was undefined — so each test now installs a clean memory-backed `Storage` via `Object.defineProperty`). 5 tests cover round-trip, localStorage key format, project-scoped isolation, path-switching via `reloadProjectStorage`, and persistence across reload. Adds a `nuxtMetaPlugin` in `vitest.config.ts` that rewrites `import.meta.client` → `true` and `import.meta.server` → `false` in `/app/` files at Vite transform time (excluding `node_modules`), so real Nuxt-flavoured composables run under Vitest without `import.meta.client` guards silently short-circuiting

### Workflow & Documentation
- **Updated bd version policy**: Removed the outdated "stay on bd 0.49.x" restriction from CLAUDE.md. The app's Rust backend auto-detects the installed bd version and adapts via version-gated helpers — it works with any bd version (0.49 through 1.0.x). The original restriction was written before steveyegge fixed server mode regressions (upstream issue #2050, now closed). Documented self-managing Dolt server (bd 0.57+) and native auto-flush/auto-import
- **Removed `beads-auto-sync.sh` hook**: This hook ran `bd export -o .beads/issues.jsonl` after every bd write command. It was a workaround from the bd 0.49 era when `bd sync` was removed but auto-flush didn't exist yet. bd 0.57+ auto-flushes Dolt → JSONL natively (5s debounce, enabled by default). Nothing in our workflow reads JSONL within that window — the Tauri app uses `bd list --json` (reads Dolt directly), and git commits take longer than 5s. Hook removed from `.claude/settings.json` and deleted
- **`release.sh` now stages `Cargo.lock`**: After bumping the version in `Cargo.toml`, the script also updates `beads-issue-tracker`'s version entry in `Cargo.lock` (via awk) and includes it in the release commit — prevents a dirty `Cargo.lock` from being left out of the version tag
- **Release notes template enriched**: Both the versioned release (`v*` tag) and the rolling `latest` dev-build body blocks in `.github/workflows/release.yml` now include a Requirements section (bd 0.49.x notice) and a macOS unsigned-app workaround (`xattr -cr`) so every future GitHub Release carries these notices automatically

## [2.2.0] - 2026-04-16

> Requires **bd 0.49.x** — do not use bd 0.50–0.56+ (they remove embedded Dolt and CGO support).

### New Features
- **Multi-copy issue IDs everywhere**: Hold ⌘ (macOS) or Ctrl (Windows/Linux) and click any copy-ID button — in the sidebar QuickList, in the main IssueTable rows (epics, children, regular tasks), or in the IssueDetailHeader — to accumulate issue IDs in the clipboard as a comma-separated list. All buttons share a single buffer via the new `useMultiCopy` composable, so you can Cmd+click tasks across the sidebar and the main table and get them all in one paste. Selected items keep a persistent green checkmark until the buffer resets. Cmd/Ctrl+click on an already-selected item removes it from the buffer; a plain click resets the buffer and copies a single ID with a 2s checkmark as before

### Fixes
- **`start-dev.sh` leaves Nuxt/Vite zombies**: The script's `pkill` block only targeted the Tauri binary, so Node.js dev-server processes (`pnpm tauri:dev`, `@tauri-apps/cli`, `pnpm nuxt dev`, `nuxt.mjs dev`, Vite, esbuild) survived restarts and kept serving stale in-memory modules — code changes did not appear after "restart via script". Completely rebuilt the zombie-killing block: uses `pkill -9` on a loop of `$PROJECT_ROOT`-scoped patterns (nuxt/tauri/vite/esbuild/pnpm), then port-checks 3000 and 3133 and force-kills any lingering listeners that belong to the project (refuses to kill processes from other projects — scripts on other Vite dev servers are safe). Added a new `[1.5/5]` step that wipes `.nuxt`, `node_modules/.vite`, and `node_modules/.cache` on every startup so HMR can never serve stale bundles. The installed app in `/Applications/Beads Task-Issue Tracker.app` is explicitly protected: all patterns are scoped to `$PROJECT_ROOT` or the npm package name `beads-task-issue-tracker`, neither of which appears in the installed app's command line
- **Duplicate window title on macOS**: Added `hiddenTitle: true` alongside existing `titleBarStyle: Overlay` in `tauri.conf.json` so the native title bar text no longer overlaps the custom `AppHeader` title
- **`start-dev.sh` kills installed app**: Scoped the first `pkill -f` match to `$PROJECT_ROOT/src-tauri/target/debug/beads-issue-tracker` so running the dev script no longer terminates the installed `/Applications/Beads Task-Issue Tracker.app` (both share the same executable name from the Cargo crate)

### Workflow & Documentation
- **`merge-to-main` skill now waits for CI before merging**: Added a new "Wait for CI" step between documentation update and PR merge that blocks on `gh pr checks <N> --watch --fail-fast`. Aborts the skill if any check fails, with an explicit instruction to investigate rather than retry blindly — prevents merging to main while GitHub Actions is still running or has failed
- **Workflow discipline rules from obra/superpowers**: Applied 8 rules across `CLAUDE.md`, supervisor agents (`tauri-`, `vue-`, `test-`, `merge-supervisor.md`), `code-reviewer.md`, and the `subagents-discipline` skill — Iron Law (Evidence before claims), four completion statuses (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), Self-Review checklist, Before-you-begin / When-over-your-head escalation blocks, Model Selection guide, Enrich-bead-with-context shortcut, Save-approved-plan artefact, two-stage code review with `[SPEC_GAP]` / `[QUALITY]` labels
- **`.claude/` is now tracked in git**: removed `.claude` from `.gitignore` so agent definitions, hooks, skills, and workflow docs ship with the repo. `.claude/settings.local.json` remains gitignored (machine-local permissions)

## [2.1.0] - 2026-04-06

### New Features
- **CI workflow**: GitHub Actions CI runs TypeScript check, frontend tests, and Rust compilation on every PR and push to main
- **Workflow KPI**: New "Workflow" KPI card shows active (non-blocked, non-closed) issues; "All" KPI card shows everything including closed
- **Blocked issues section**: Collapsible "Blocked" quick-list in the dashboard sidebar
- **Copy Issue ID**: One-click copy button on dashboard quick-list items
- **Column drag-and-drop**: Reorder table columns via drag handle in column settings panel (persisted per project)
- **Pipeline diagnostics**: New "Pipeline" tab in Debug Panel shows real-time watcher/scheduler/poll counters with color-coded values
- **Churn stress tooling**: Stress test suite, shell script, and runbook for validating app stability under sustained file churn

### Fixes
- **Dolt detection**: Recognize `embeddeddolt/` folder as Dolt indicator in addition to `.dolt/` and `dolt/` layouts, fixing badge display for projects using newer bd versions
- **Pipeline stability**: Replace debounce+isProcessing with queue-based single-flight handler; add poll backpressure scheduler (min 2s between expensive poll cycles); Rust-side watcher rate-limiting with noise filtering — prevents UI freezes under heavy `.beads` churn
- **Blocked state model**: Unified `isIssueBlocked()` and `pruneClosedBlockers()` in issue-helpers — fixes stale blocked indicators, correctly handles dependency-blocked issues across KPI stats, filters, table, and detail views
- **Search respects filters**: Text search now intersects with active status/type/priority/assignee filters instead of bypassing them
- **Filter checkbox rendering**: Switch `:checked` to `:model-value` on all filter dropdown checkbox items (shadcn/reka-ui fix)
- **Filter chips always visible**: Show active filter chips during search (previously hidden when search was active)
- **Open KPI accuracy**: Exclude dependency-blocked issues from Open KPI count and filter
- **blockedBy from dependencies**: Nitro server transformer now computes `blockedBy` from `dependencies` array (both `bd list` and `bd show` formats)
- **KPI card clipping**: Use `outline` instead of `ring` for active state; flex-wrap layout with min-width prevents truncation
- **Window title bar**: Apply `titleBarStyle: Overlay` only on macOS (programmatic window creation); graceful error handling for `startDragging` and `setTitle`
- **Tombstone removal**: Remove `tombstone`/deleted status handling from types, filters, UI, backend, and stats — simplifies the entire status model

### Refactoring
- **StatusBadge tooltip**: Blocked-by tooltip moved from IssueTable (4 duplicated blocks) into StatusBadge component; removed redundant `useIssues()` call and `Ban` icon import from IssueTable

> Cherry-picked from [w3dev33/beads-task-issue-tracker#11](https://github.com/w3dev33/beads-task-issue-tracker/pull/11) by Devon Katz ([@drkatz](https://github.com/drkatz)) with [Amp](https://ampcode.com)

---

## [2.0.0] - 2026-03-31

> Community fork by [Maxpceo](https://github.com/Maxpceo). Requires **bd 0.49.x**. Recommended CLI: **br 0.1.14**.

### New Features
- **Resizable comment section**: Drag the bottom edge of the comment area to resize (160-500px), height saved per project
- **Comment navigation (TOC)**: Click the list icon next to "Comments (N)" to see a table of contents — click any entry to jump to that comment with highlight
- **Breadcrumb navigation**: Navigate dependency and relation links with clickable breadcrumbs

### Fixes
- **Dashboard error handling**: Show error message when bd CLI fails to load issues
- **Blocked icon**: Hide lock icon when all blockers are closed

---

## [1.24.2] - 2026-03-03

> Requires **bd 0.49.x**. Recommended CLI: **br 0.1.14**.

### Fixes
- **Toast notifications unreadable in light theme** (#8): Added theme-aware backgrounds (light pastel tones in light mode, original dark backgrounds preserved in dark mode) and adjusted icon contrast. Increased default display duration from 3s to 5s
- **No window title on Windows** (#9): Set default window title to "Beads Task-Issue Tracker" and dynamically update it with the current project name for Windows task switchers (PowerToys Run, Flow Launcher, Switcheroo, etc.)

## [1.24.1] - 2026-02-27

> Requires **bd 0.49.x**. Recommended CLI: **br 0.1.14** — br 0.1.20 has a regression with older databases (fsqlite schema parsing bug), avoid until fixed.

### New Features
- **Pinned issues always on top**: Pinned issues float to the top of the table regardless of sort field and direction, with a visual separator between pinned and non-pinned sections
- **Epic sort order fix**: `groupIssues` now uses single-pass iteration so epics follow the active sort order instead of being forced to the top

### Fixes
- **Lock icon not disappearing after blocker is completed** (#7): When a blocking issue was closed, the lock icon on dependent issues remained visible due to stale cached `blockedBy` data. The icon now disappears automatically on the next poll, and dependent issues are immediately refreshed when a blocker is closed from within the app

## [1.24.0] - 2026-02-25

> Requires **bd 0.49.x**. Recommended CLI: **br** (beads_rust) — use **br 0.1.14** (0.1.19 had a regression, fixed in 0.1.20).

### New Features
- **Pin/favorite issues**: Pin issues to the dashboard with a dedicated "Check This Out" section and a pin column in the issues table
- **Keyboard navigation**: Full keyboard navigation for tables and lists — arrow keys, Enter to select, Escape to deselect
- **Pinned sort modes**: Sort pinned issues by date added, last updated, or manual drag-and-drop order

### Fixes
- **Pinned column sort**: Sorting by the pinned column now works correctly in the issues table

### Docs
- **CLI usage note**: Added side-by-side CLI usage note in README

## [1.23.0] - 2026-02-24

> **Recommended CLI: [`br`](https://github.com/Dicklesworthstone/beads_rust) (beads_rust)** — faster, more optimized, and our primary choice going forward. `bd 0.49.x` remains supported as a fallback. If `bd` with Dolt regains comparable reactivity and performance in future versions, we'll reconsider.

### Attachments Overhaul
- **Filesystem-only attachments**: The `.beads/attachments/` directory is now the sole source of truth — no more reliance on `external_ref` for path storage
- **Auto-migration v3**: Existing projects are automatically migrated on first open (backup created, refs cleaned, files preserved)
- **Multi-file attach**: Attach multiple images or markdown files in a single operation
- **Removed `cleared:{id}` sentinel**: Empty `external_ref` now uses native empty string (converted to `null` internally by `br`/`bd`) — simpler, no more sentinel values
- **Attachment refresh fix**: Cache invalidation after attach/detach + proper watch on issue object changes

### Notifications
- **External status change toasts**: Toast notifications when issues are closed, deleted, or reopened externally (via CLI or another tool)
- **Tombstone detection**: `br delete --hard` creates tombstone status — now properly detected and surfaced as a delete notification

### Code Cleanup
- **Removed dead code**: `delete_attachment_file`, `cleanup_empty_attachment_folder` (Rust + TS), legacy external_ref path restoration in migration
- **Native logger**: All debug logging uses the native `logFrontend()` → Rust `log::info!` pipeline (log file: `~/Library/Logs/com.beads.manager/beads.log`)

## [1.22.0] - 2026-02-22

> Requires **bd 0.55+** for optimal performance. Compatible with bd 0.50+ (with fallback).

### Improvements
- **Rename favorites to projects** across UI and composables
- **Delete issue notification** — Shows a notification when an issue is deleted from the UI (single, multi-select, epic)
- **Unified change detection** — Replace `useBeadsWatcher` with `useChangeDetection` composable (native file watcher)

### Fixes
- **Fix bd delete flags** for bd 0.50+ (`--hard` flag removed)

## [1.21.0] - 2026-02-21

> Requires **bd 0.55+** for optimal performance. Compatible with bd 0.50+ (with fallback).

### Code Quality & Maintainability
- **Refactor `index.vue`**: Reduced from 2533 to ~1250 lines (~51%) by extracting 2 composables and 4 components
  - `useSidebarResize` composable — sidebar state and resize handlers
  - `useIssueDialogs` composable — dialog state and 20+ handlers
  - `IssueDetailHeader` component — deduplicates desktop/mobile detail header
  - `DashboardContent` component — deduplicates desktop/mobile dashboard
  - `IssueListPanel` component — deduplicates desktop/mobile issue list
  - `DialogsLayer` component — groups 8 dialogs + image/markdown preview
- **Extract pure logic** from composables into testable utility modules
  - `issue-helpers.ts` — deduplication, natural sort, filtering, sorting, grouping, dashboard stats
  - `favorites-helpers.ts` — path normalization, dedup, sorting

### Testing
- **Vitest setup** with jsdom environment, path aliases, and test/test:watch scripts
- **179 unit tests** across 7 test files covering all pure utility functions
  - `markdown.ts` — image/ref extraction, rendering, XSS sanitization
  - `issue-helpers.ts` — deduplication, natural sort, filtering, sorting, epic grouping, dashboard stats
  - `favorites-helpers.ts` — path normalization, dedup, sort modes
  - `path.ts` — cross-platform path splitting and separator detection
  - `open-url.ts` — URL validation, local path detection, URL normalization
  - `hash.ts` — DJB2 hash determinism

## [1.20.1] - 2026-02-20

> Requires **bd 0.55+** for optimal performance. Compatible with bd 0.50+ (with fallback).

### bd 0.55 Compatibility & Stability
- **Per-project mutex**: Serializes all `bd` CLI calls per project to prevent concurrent Dolt embedded access that caused SIGSEGV crashes (nil pointer dereference in dolthub/driver)
- **Single `bd list --all` call**: Uses the fixed `--all` flag in bd 0.55+ instead of 2 separate calls (open + closed), with automatic fallback for older versions
- **Dolt mtime detection fix**: `get_beads_mtime()` now scans the nested Dolt layout (`.beads/dolt/<name>/.dolt/`) introduced in bd 0.52+, in addition to the legacy layout

### Project Switch Optimization
- **Stop polling/watcher before switch**: Prevents concurrent `bd` calls from the old project's poll cycle and watcher cascade during project switch
- **Pre-flight checks in parallel**: Migration check and mtime reset run concurrently before data load
- **Watcher resumes after data load**: Avoids self-triggered cascade polls from `bd` writing to `.beads/`

### Bug Fixes
- Add missing `IssueStatus` values (deferred, tombstone, pinned, hooked) in FilterChips and IssueTable
- Fix Vue runtime warnings from directives on TooltipProvider
- Fix zoom breaking favorites drag and drop reordering
- Fix favorite removal modal not showing and duplicate entries

## [1.20.0] - 2026-02-19

> **bd 0.50+ compatibility** — This release adds full support for the Dolt backend introduced in bd 0.50.
> The app remains fully compatible with earlier bd versions (SQLite backend).
> If you upgrade bd to 0.50+, projects still using the legacy SQLite backend will be detected and a migration modal will prompt you to migrate on first open — all data is preserved.

### bd 0.50+ Compatibility
- **Backward compatible**: The application continues to work with bd versions prior to 0.50 (SQLite backend) without any changes.
- **Dolt migration modal**: When using bd >= 0.50, projects still on SQLite are detected and a migration modal prompts the user to run a one-time migration. All data (issues, labels, dependencies, comments, attachments) is preserved.
- **Parent-child is now structural (bd >= 0.50 only)**: Parent-child relationships are determined by dot notation in issue IDs (e.g., `abc.1` is a child of `abc`). The parent selector is hidden in the issue form for bd >= 0.50. **Known limitation**: it is no longer possible to attach an existing issue to an epic after creation — children can only be created from the parent issue (via "Create child"), which assigns the correct ID prefix automatically. This does not affect users on earlier bd versions, where the parent selector remains available.

### New Features
- **Dolt migration modal**: Detects SQLite projects on open and prompts the user to run the migration with progress feedback
- **7-step migration process**: Export JSONL → backup → init Dolt → import → restore labels, dependencies, comments → convert attachment paths to absolute
- **Empty project migration**: Projects with zero issues are handled gracefully (init-only migration)
- **Dot notation parent-child derivation**: Parent and children relationships are derived from the loaded issues list based on ID structure
- **Short ID in preview header**: Issue preview shows the short suffix (e.g., `d6rp`) instead of the full ID, while still copying the full ID to clipboard
- **Per-project Dolt detection**: Dolt logo badge displayed in project browser and debug panel for migrated projects

### Improvements
- **Dolt logo readability**: Enlarged Dolt SVG logo in FolderPicker badges for better visibility
- **FolderPicker cleanup**: Removed manual "Migrate to Dolt" button — migration is now handled automatically by the mandatory modal
- **Migration error handling**: Reset error messages when switching between projects
- **Race condition prevention**: Migration check runs before any bd CLI command to prevent bd auto-migration from bypassing the custom 7-step process

### Bug Fixes
- **Blue flash animation**: Prevent flash on all rows when switching projects (only flash newly added issues)
- **bd --version isolation**: Run `bd --version` from temp directory to avoid triggering auto-migration in project directories

## [1.18.4] - 2026-02-17

> Requires **bd 0.49.3+** for full feature support.

### New Features
- **New issue flash animation**: Newly added issues highlight with a blue flash (status "open" color) that fades over 3 seconds, works for both in-app creation and external CLI additions detected via polling

### Bug Fixes
- **Column sort persistence**: Persist column sort preferences per project so sorting is remembered across sessions
- **Issue preview auto-refresh**: Auto-refresh issue preview on any field change, not just status updates
- **Epic child ordering**: Sort epic child issues by ID suffix for consistent ordering

## [1.18.3] - 2026-02-16

> Requires **bd 0.49.3+** for full feature support.

### Bug Fixes
- **Changelog fetch caching**: Use GitHub Contents API instead of raw.githubusercontent.com CDN which ignores cache-busting query params, causing stale changelog in update checker

## [1.18.2] - 2026-02-16

> Requires **bd 0.49.3+** for full feature support.

### Bug Fixes
- **Dashboard short IDs**: Show key suffixes (e.g., `d6rp`) instead of full IDs in Ready to Work and In Progress panels
- **Scroll to selected row**: Clicking an issue in dashboard panels now smooth-scrolls the table to the corresponding row
- **Logo green circle**: Restore hardcoded green color on first logo circle after accidental override
- **Changelog caching**: Bypass GitHub CDN cache when fetching changelog for accurate update checks

## [1.18.1] - 2026-02-16

> Requires **bd 0.49.3+** for full feature support.

### Improvements
- **Badge color semantics**: Swap Open (now blue) and In Progress (now green) status badge colors — green consistently means active work
- **Epic badge color**: Changed from green to indigo to avoid confusion with active status
- **P3 priority color**: Changed from green to dark goldenrod for better contrast with P2 amber
- **Epic progress bar**: Now uses in-progress green instead of primary blue
- All changes applied across Classic, Dark Flat, Light Flat, and Neon themes

## [1.18.0] - 2026-02-16

> Requires **bd 0.49.3+** for full feature support.

### New Features
- **Extensible theme system**: 4 built-in themes — Classic Light, Classic Dark, Dark Flat, and Neon
- **Neon theme**: Deep dark UI with transparent glowing badges, neon-colored text, glow effects on KPI cards, charts, dependency links, and filter chips
- **Dark Flat theme**: Clean solid-color badges without gradients for a minimal look
- **Light Flat theme**: Same flat badge style adapted for light mode
- **Theme selector**: New section in Settings dialog with visual theme cards
- **Header theme cycling**: Click the theme icon to cycle through all themes
- **Theme-aware Label badges**: Dynamic neon palette for labels in Neon mode

### Improvements
- **CSS custom properties architecture**: All badge colors driven by CSS variables — adding a new theme = one CSS block, zero component changes
- **Auto-migration**: Existing users with `beads:darkMode` setting are automatically migrated to the new theme system
- **Epic row backgrounds**: Fixed hardcoded dark background for proper light theme support
- **Slimmer chart bars**: Progress bars reduced for a cleaner dashboard

## [1.17.2] - 2026-02-14

> Requires **bd 0.49.3+** for full feature support.

### Bug Fixes
- **Tombstone issues shown as Open**: Soft-deleted issues (`tombstone` status) were displayed as "Open" because `normalize_issue_status()` converted unknown statuses to `"open"`

### New Features
- **Extended bd status support**: Added `deferred`, `tombstone`, `pinned`, `hooked` statuses with distinct badge colors (amber, stone, purple, cyan) and filter options

## [1.17.1] - 2026-02-14

> Requires **bd 0.49.3+** for full feature support.

### Improvements
- **Short IDs in table column**: ID column now shows only the key suffix (e.g., "22g" instead of "task-issue-tracker-demo-22g"), replacing the unreliable common-prefix algorithm with direct suffix extraction

## [1.17.0] - 2026-02-14

> Requires **bd 0.49.3+** for full feature support.

### New Features
- **Epic progress bar**: Collapsed epics show a completion progress bar with percentage and current in-progress child task when the epic or a child is actively being worked on
- **Short IDs in preview panel**: Children, dependencies (blockers), and relations now display short IDs without the project prefix for better readability

### Improvements
- **Dependencies & relations line layout**: Replace compact badges with full-width clickable rows showing ID (colored by priority) + title for dependencies and relations
- **Always show changelog**: Update dialog now always displays the full changelog instead of requiring a click

### Bug Fixes
- **Redundant label removed**: Remove duplicate "What's new" label above changelog in update dialog

## [1.16.0] - 2026-02-13

> Requires **bd 0.49.3+** for full feature support.

### New Features
- **Add/remove relations**: Create and remove non-blocking relations (relates-to, duplicates, supersedes, caused-by, etc.) directly from the issue detail view
- **Modal dialogs for blockers and relations**: Replace inline autocomplete forms with proper modal dialogs for a more reliable and spacious UI
- **Dynamic relation types**: Available relation types adapt to the detected CLI client (bd: 10 types, br: 7 types)
- **Relations on closed issues**: Relations can be added and removed on closed issues (e.g. retroactively linking duplicates)
- **Search across all issues**: Modal search field searches open and closed issues regardless of the filter state
- **Exclude closed filter**: Toggle filter in the relation modal to show/hide closed issues when browsing

### Improvements
- **Priority-colored IDs in modals**: Issue IDs are colored by priority (red/orange/green/gray) in both blocker and relation modals
- **StatusBadge in modals**: Each issue in the selection list shows its status badge for quick identification
- **Priority border fallback**: Relation badges now look up priority from loaded issues when the backend doesn't provide metadata

### Bug Fixes
- **Relation removal direction**: Fix remove not working when the relation direction is "dependent" (inverse dependency order)

## [1.15.1] - 2026-02-13

> Requires **bd 0.49.3+** for full feature support.

### Bug Fixes
- **Epic colored borders always visible**: Borders no longer disappear when collapsing an epic or filtering by closed status
- **Distinct epic colors**: Use index-based color assignment instead of ID hash to prevent color collisions between epics
- **No status color confusion**: Replaced blue/green/red border colors with amber/violet/teal to avoid visual conflict with status badges

## [1.14.0] - 2026-02-12

> Requires **bd 0.49.3+** for full feature support.

### New Features
- **Live updates via native file watcher**: Replace the 1s mtime polling loop with a debounced native filesystem watcher (`notify` crate). External changes (e.g. `bd create` from the terminal) are detected instantly with near-zero CPU usage when idle. The previous adaptive polling remains as a 30s safety net with graceful degradation if the watcher fails to start.

### Technical Details
- Rust-side: 1000ms debounce covers SQLite WAL write bursts, `NonRecursive` watch on `.beads/` only
- Frontend: 300ms event coalescing + 3s self-trigger cooldown prevents cascading from bd sync writes
- New `useBeadsWatcher` composable with concurrency guard and project path filtering
- `useAdaptivePolling` upgraded with watcher-aware mode (30s safety net replaces 5s+1s polling)

## [1.13.2] - 2026-02-11

> Requires **bd 0.49.3+** for full feature support.

### New Features
- **Fast mtime detection**: Decouple cheap mtime check (1s interval) from data fetch (5s poll). External changes are now detected in ~1s instead of ~5s, with zero CPU cost when nothing changed
- **bd CLI update detection**: Debug Panel now shows when a newer version of the bd CLI is available, with direct link to releases

### Bug Fixes
- **View on GitHub button**: Always show "View on GitHub" button in the update dialog, not just when an update is available

## [1.13.1] - 2026-02-11

> Requires **bd 0.49.3+** for full feature support.

### Bug Fixes
- **File picker on Linux**: Add "All supported files" filter as default in file dialogs so Markdown files are visible without manually switching filters (GTK defaults to first filter)

## [1.13.0] - 2026-02-10

> Requires **bd 0.49.3+** for full feature support. Core features work with bd 0.42+.

### New Features
- **Metadata display**: Read-only formatted JSON display of per-issue metadata in detail view (set via `bd update --metadata`)
- **Spec ID field**: Full create/edit support for the `spec_id` field linking issues to specification documents
- **Comment count column**: New "Comments" column in issue list (hidden by default, enable via column config), with fallback to comments array length
- **bd/br client detection**: Automatic detection of CLI client type (bd vs br) with version-aware feature profiles
- **bd 0.50.0 compatibility**: Version-aware compatibility layer that auto-disables `--no-daemon` flag and JSONL file watching for bd 0.50.0+
- **In Progress sidebar**: Dashboard sidebar now shows issues currently in progress

### Improvements
- **Column config auto-sync**: New default columns are automatically added to persisted column config for existing users
- **Philosophy documentation**: Project philosophy integrated into README

### Bug Fixes
- **Graceful missing issues**: Handle missing issues in `bd_show` without crashing

## [1.12.2] - 2026-02-10

### New Features
- **LATEST release mode**: New workflow mode to quickly publish development builds without version bump, overwriting the same `latest` GitHub release
- **Full changelog in update dialog**: Update dialog now fetches and displays the full CHANGELOG.md instead of just the release body
- **Auto-copy xattr command**: On macOS, clicking "Download & Quit" automatically copies the `xattr -cr` command to clipboard

### Improvements
- **App menu reorganization**: Moved Settings, Check for Update, and Show Logs into the main app menu; removed standalone Debug menu
- **Colored markdown headings**: Compact markdown variant now has colored headings (h1-h4) and styled strong text for dark/light modes
- **Wider update dialog**: Increased dialog width and changelog scroll height for better readability

## [1.12.1] - 2026-02-10

### Bug Fixes
- **Update download errors**: Add error logging and fix error display for update download failures

## [1.12.0] - 2026-02-10

### New Features
- **Configurable CLI binary**: Add configurable CLI binary path for bd-compatible forks, allowing users to specify a custom binary in settings

## [1.11.0] - 2026-02-10

### New Features
- **Sortable favorites**: Drag-and-drop reordering of sidebar favorites with grip handles
- **Sort mode toggle**: Cycle between A-Z, Z-A, and manual order via header button
- **Reset button**: Quick reset to alphabetical order after manual reordering, appears only when needed

### Bug Fixes
- **Project path field**: Fixed path field not updating when opening picker from favorites

## [1.10.4] - 2026-02-10

### New Features
- **Changelog in update dialog**: Release notes from GitHub are now displayed in a scrollable "What's new" section when an update is available
- **Download & Quit**: New button downloads the update (DMG on macOS), mounts it, and closes the app automatically
- **macOS xattr helper**: Shows the `xattr -cr` command with click-to-copy for unsigned app workaround

### Bug Fixes
- **Window close permission**: Added missing `core:window:allow-close` Tauri capability that prevented the app from closing after download

## [1.10.3] - 2026-02-09

### Bug Fixes
- **Stale issue list on project switch**: Fixed mtime tracking using a global singleton that caused stale data when switching between favorite projects. Now uses per-project HashMap to track mtimes independently
- **Slow refresh after favorite change**: Added `bd_reset_mtime` command to invalidate cached mtimes on project switch, ensuring immediate refresh with correct data

### Improvements
- **Markdown CSS consolidation**: Refactored markdown preview styles into a shared CSS base with table support
- **README documentation**: Expanded feature documentation with attachments, bulk operations, and keyboard shortcuts

## [1.10.1] - 2026-02-08

### Improvements
- **Debug panel toggle**: Replaced sync indicator with a debug panel toggle button in the footer for quicker access
- **Attachment documentation**: Added `docs/attachments.md` explaining how the app repurposes `bd`'s `--external-ref` field to implement file attachments, with scripting examples

## [1.10.0] - 2026-02-08

### Improvements
- **Reduced CPU/disk usage**: 4-layer polling optimization — sync cooldown, filesystem mtime check, batched poll command, and adaptive polling intervals. Most poll cycles now spawn zero bd processes
- **Debug Panel smart scroll**: Log view no longer jumps to bottom on auto-refresh when scrolled up, allowing inspection of older entries

### Bug Fixes
- **Debug Panel logging**: Backend logging is now automatically enabled when the Debug Panel is open (was silently disabled)
- **mtime guard accuracy**: Fixed mtime check always reporting "changed" by snapshotting after all poll-triggered db operations complete

## [1.9.0] - 2026-02-07

### New Features
- **Markdown file preview**: View attached `.md` files in a full-screen dialog with rich rendering (headers, tables, code blocks, blockquotes)
- **Inline markdown editing**: Edit markdown files directly in the preview dialog using contentEditable, with save confirmation
- **Markdown attachments**: Attach `.md`/`.markdown` files to issues alongside images, displayed as clickable links in the attachments section
- **Markdown gallery navigation**: Browse multiple markdown attachments with arrow navigation (same UX as image gallery)

### Improvements
- **Diagonal gradient badges**: All badge types now use diagonal gradient styling
- **GitHub footer link**: Added GitHub icon in footer and repository link in update dialog
- **Favorites auto-cleanup**: Users are notified when invalid favorite paths are automatically removed at startup

## [1.8.2] - 2026-02-06

### Bug Fixes
- **Epic children grouping**: Re-parented issues (moved under an epic via `bd update --parent`) now correctly appear grouped under their epic in the table view, not as standalone issues

## [1.8.0] - 2026-02-06

### New Features
- **Label multiselect component**: Replace comma-separated labels input with a multiselect featuring colored badges, search/filter, and create new labels on the fly
- **Periodic update check**: App now checks for updates hourly in the background

### Bug Fixes
- **Database migration repair**: Detect and repair bd 0.49.4 schema migration errors with user-controlled repair dialog for affected projects

## [1.7.0] - 2026-02-04

### New Features
- **Per-project settings isolation**: Filters, column configuration, expanded epics, and collapsible section states are now stored per project using localStorage namespacing with djb2 hash
- **Multi-image navigation**: Preview modal now supports navigating between multiple attached images

### Improvements
- **Image thumbnails**: Reduced thumbnail size to 180px for better layout
- **Preview sections**: 11 collapsible sections in issue preview now persist state per project

## [1.6.5] - 2026-02-03

### Bug Fixes
- **Permanent issue deletion**: Issues now use `--force --hard` flags for permanent deletion, preventing deleted issues from reappearing after sync
- **Delete error notification**: Show error notification when issue deletion fails
- **Filter dropdown behavior**: Exclusion dropdown now properly closes other filter dropdowns
- **Duplicate issues**: Fixed deduplication when merging open/closed issue lists

### Improvements
- **Documentation**: Updated CLAUDE.md with dev server instance management instructions

## [1.6.4] - 2026-01-29

### Bug Fixes
- **EPIC display issues**: Fixed missing EPIC ID in preview, improved children grouping display, and corrected border styling

## [1.6.3] - 2026-01-29

### Bug Fixes
- **Label filter OR logic**: When filtering by multiple labels, issues now show if they have at least one of the selected labels instead of requiring all labels

## [1.6.2] - 2026-01-29

### Bug Fixes
- **External ref persistence**: Clearing the external_ref field now persists correctly using a sentinel value to satisfy the SQLite UNIQUE constraint

## [1.6.1] - 2026-01-29

### New Features
- **Epic deletion confirmation**: Confirmation dialog when deleting an Epic with options for handling child issues

### Bug Fixes
- **Sticky table header**: Table header now stays fixed at top when scrolling through issues

## [1.6.0] - 2026-01-29

### New Features
- **Parent/child relationship management**: Attach or detach issues to/from Epic parents via dropdown selector in edit form
- **Create child from Epic**: New "Create child" button in Epic preview to quickly create child issues with parent pre-selected
- **Epic visual styling**: Colored left borders on Epic rows for better visual distinction

### Improvements
- **Smart form fields**: Parent selector hidden when editing Epic issues (Epics cannot have parents)
- **CLAUDE.md documentation**: Added gotchas about external_ref UNIQUE constraint and its various uses

### Bug Fixes
- **Fix update failures**: Skip empty --external-ref to avoid UNIQUE constraint errors that caused silent update failures

## [1.5.0] - 2026-01-29

### New Features
- **Exclusion filter panel**: Hide issues by type, labels, status, priority, or assignee via a new dropdown with collapsible sections
- **Assignee filter dropdown**: Multi-select filter by assignee with slate-colored badge
- **Two-row filter chips**: "Filters:" row for inclusions, "Hidden:" row for exclusions with independent Clear buttons

### Improvements
- **Red checkmark indicator**: Excluded items show bright red checkmark (#ff3333) with grayed text
- **Auto-open sections**: Exclusion sections auto-open when they contain active filters
- **Unified filter order**: Type, Labels, Status, Priority, Assignee across all filter components
- **Project-specific reset**: Labels and assignees exclusions cleared on project change

## [1.4.0] - 2026-01-29

### New Features
- **Hierarchical epic display**: Child issues are now grouped under their parent epic with collapsible sections
- **Epic progress badge**: Shows closed/total count on epic rows (e.g., "1/10")
- **Short ID display**: Table shows only the unique ID suffix without project prefix (full ID still copied)
- **Natural ID sorting**: IDs with numbers now sort correctly (40b.2 before 40b.10)

### Improvements
- **Visual hierarchy**: Child rows have darker background to distinguish from parent
- **Compact table rows**: Reduced vertical padding in table cells
- **Markdown spacing**: Fixed double-spacing issue in description panel
- **Quick list spacing**: Reduced spacing in "Ready to Work" list

## [1.3.0] - 2026-01-29

### New Features
- **Image attachment system**: Attach images from local files or URLs to issues, stored in `.beads/attachments/{issue-id}/`
- **Attachment cleanup**: Automatic purge of orphan attachment folders when deleting issues
- **File deletion on detach**: Detaching an image from an issue now deletes the file from attachments folder
- **Closed issue restrictions**: Closed issues are now read-only (no edit, attach, comment) until reopened
- **Reopen button**: New button to reopen closed issues directly from the preview panel
- **Action notifications**: Toast notifications for all issue actions (create, save, close, reopen, comment) with issue ID and title

### Improvements
- **Update dialog**: Replaced footer version tooltip with a proper update dialog
- **TypeScript fixes**: Fixed type errors in IssueTable, bd-api, markdown, and count.get

## [1.2.2] - 2026-01-28

### Bug Fixes
- **Filter dropdown behavior**: Fix Tooltip/DropdownMenu nesting order that was blocking click events
- **Exclusive filter state**: Clicking one filter now automatically closes the others
- **Click outside handling**: Clicking outside filter buttons now properly closes the open dropdown

## [1.2.1] - 2026-01-28

### New Features
- **Image preview system**: Issue attachments (screenshots) now display as thumbnails in an "Attachments" section
- **Full-screen image viewer**: Click on thumbnails to view images in a full-screen modal
- **Secure image handling**: Tauri commands restricted to image files only (png, jpg, gif, webp, svg, etc.)

## [1.2.0] - 2026-01-28

### New Features
- **Multi-select filter dropdowns**: Replaced the monolithic "Filter" dropdown with 4 individual filter buttons (Status, Type, Priority, Labels)
- **Label multi-select filter**: Labels now support multi-selection with AND logic (issues must have ALL selected labels)
- **Collapsible favorites section**: Favorites in the sidebar can now be collapsed/expanded

### Improvements
- **Colored filter chips**: Filter badges now use the same colors as the app badges (status, type, priority, labels)
- **Filter tooltips**: Added helpful tooltips to each filter button

## [1.1.5] - 2026-01-28

### Bug Fixes
- **Fix clearing issue fields**: Fields like design notes, acceptance criteria, working notes, assignee, and labels can now be properly cleared when editing an issue

## [1.1.4] - 2026-01-28

### Bug Fixes
- **Search filter now bypasses other filters**: When searching, all issues (including closed ones) are now searched, instead of only searching within already-filtered results

## [1.1.3] - 2026-01-27

### Bug Fixes
- **Bidirectional sync**: Local changes now persist correctly (was using `--import-only` which overwrote local changes)
- **Tolerant JSON parsing**: Handles malformed bd CLI output gracefully, displays valid issues even when some fail to parse
- **bd update fix**: Empty arguments no longer cause update failures

### Debug Panel Enhancements
- **Export logs**: New button to export logs to Downloads folder with path display
- **BD version display**: Shows bd CLI version in Debug Panel header
- **Conditional logging**: Logs disabled by default for better performance
- **Log rotation**: 5MB max file size with automatic rotation (keeps 1 backup)

### Data Structure Updates
- Added support for new bd CLI dependency format
- Added `close_reason`, `issue_id`, `dependency_count` fields
- Made dependency fields optional for compatibility

## [1.1.2] - 2026-01-27

### New Features
- **Debug Panel** accessible via menu `Debug > Show Logs...` or `Cmd+Shift+L`
- **Live/Paused mode** for real-time log monitoring
- **Verbose mode** to display detailed bd command output
- **Force Sync** moved to Debug Panel
- **Colorized logs** by command type for better readability
- **Clear logs** with one click
- **Resizable panel** (up to 50% of screen height)

### Technical Improvements
- Logging enabled in release builds for diagnostics
- Simplified logs by default (byte count only)
- Verbose option to see bd response content

## [1.1.1] - 2026-01-26

### New Features
- **Native macOS Menu**: Added "Check for Update..." menu item in the app menu
- Full native menu bar with Edit (Undo, Redo, Cut, Copy, Paste) and Window menus
- Update dialog shows loading state, version comparison, and download button
- About dialog with app icon, version and credits

### UI Improvements
- Added checkmark icon to "You're up to date" message in footer
- Unified update status text across menu dialog and footer

### Bug Fixes
- **Credits Tooltip**: Fixed tooltip position that was appearing below the viewport instead of above the footer
