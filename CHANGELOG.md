# Changelog

## [Unreleased]

### New Features
- **Notification Center** (`beads-task-issue-tracker-51z`): macOS-style notification history panel accessible via a bell icon in the header. Persists the last 100 toast notifications per project (localStorage, project-scoped key). Panel opens as a dropdown; clicking any entry opens the related issue. Unread count badge on the bell icon; panel auto-marks all notifications as read on open. Clear All button wipes the history. Powered by `useNotificationCenter` composable + `NotificationCenter.vue` component.

### Added
- Hook `block-worktree-in-repo.sh` — PreToolUse:Bash guard that blocks `bd worktree create` and `git worktree add` unless the target path is inside `~/Projects/worktrees/beads-task-issue-tracker/`. Prevents worktrees from being created inside the repo root.

### Documentation
- **Documented Rust file-watcher coalescing logic** (`beads-task-issue-tracker-uko`): debounce window (1000 ms), min-emit interval (2000 ms, env-override, floor 250 ms), starvation guard, `beads.log` counter legend (`events`/`relevant`/`emitted`/`suppressed`), and interaction with TS-side `SELF_TRIGGER_COOLDOWN_MS` — all in a new `## File Watcher Coalescing` section in `src-tauri/CLAUDE.md`.

### Performance
- **Adaptive polling interval table for Dolt projects** (`beads-task-issue-tracker-v1p`): `useAdaptivePolling` now accepts a `profile` option (`'default' | 'dolt-medium' | 'dolt-large'`) backed by an `INTERVAL_TABLE`. A new `useProjectProfile` composable detects the Dolt backend via a new Tauri command `get_project_uses_dolt` and classifies project size by issue count (<200 small, 200–999 medium, ≥1000 large). Dolt-large projects use 15s/60s/90s/180s intervals instead of 5s/30s/30s/60s, reducing idle CPU load ≥50% on large Dolt projects. Non-Dolt and small projects are unaffected (default profile). Fast 1s mtime check loop is profile-independent.
- **Faster cold open on large Dolt projects: eliminated `bd ready` subprocess spawn + reliable in-process memo** (`beads-task-issue-tracker-ho6`, `beads-task-issue-tracker-aef`): `bd ready` used to launch a separate process (~700ms on a 1040-issue Dolt project) on every poll cycle. The backend now computes readiness in-process via a pure `compute_ready_from()` function — each poll drops from 2 subprocess spawns to 1 (cold poll ~30% faster, ≈2.4s → ≈1.7s). An in-process mtime-gated memo layer (`POLL_MEMO`) uses `.beads/issues.jsonl` as the invalidation signal — bd's auto-flush (5s debounce) writes to it after any mutation (create/close/update), yet it stays stable during Dolt sql-server idle activity and bd read operations (`bd list`, `bd show`). Measured: ≥100% memo hits on a 1040-issue Dolt project over a 10-minute idle window with all mutation types correctly triggering cache invalidation. Non-Dolt and older bd/br projects retain the original 2–3 spawn path without regression via fallback on the previous mtime logic.
- **Faster cold open: `onMounted` now uses batched `fetchPollData`** (`beads-task-issue-tracker-ydr`): replaced two sequential IPC calls (`fetchIssues` + `fetchStats`) with a single batched call (`fetchPollData` + `updateFromPollData`), mirroring `handlePathChange`. Saves ~200–400 ms on first app open with a Dolt project.

### Fixed
- **Fix flag-value parsing in `block-worktree-in-repo.sh` hook** (`beads-task-issue-tracker-5pn`): `extract_worktree_path` now skips flag arguments (`--branch foo`, `-b foo`, `-B foo`, `--lock`, `--reason`) before looking for the path token. Previously, the flag value (`foo` in `--branch foo <path>`) was mistakenly treated as the worktree path, causing a false-positive deny for valid external paths.
- **Self-trigger cooldown is now armed only after local write operations (create/update/delete/etc), not after every poll cycle** (`beads-task-issue-tracker-sh7`): `notifySelfWrite()` has been removed from the unconditional post-poll path in `pollForChanges()`. Instead, `useIssues` calls it via an injected `localWriteNotifier` after each of the 11 CRUD operations (createIssue, updateIssue, closeIssue, deleteIssue, addComment, addDependency, removeDependency, addRelation, removeRelation, addLabel, removeLabel). External CLI writes arriving shortly after a poll are no longer dropped as false self-triggers.
- **Burst status-transition toasts no longer lost to self-trigger cooldown** (`beads-task-issue-tracker-12d`): shortened `SELF_TRIGGER_COOLDOWN_MS` in `app/composables/useChangeDetection.ts` from 3000ms to 500ms. `notifySelfWrite()` is called unconditionally after every poll cycle (including polls triggered by external watcher events), so the 3s window would drop any second CLI transition arriving within it. 500ms preserves mtime-echo suppression (echo is tens of ms) without eating realistic user bursts. Follow-up `beads-task-issue-tracker-sh7` tracks the deeper architectural fix (arm cooldown only after local writes).
- **Restored toast notifications for external issue status transitions** (`beads-task-issue-tracker-6nm`): `created`, `inreview`, `blocked`, `in_progress` now trigger toasts alongside existing close/reopen/delete events. Notify logic extracted into pure `app/utils/notification-matrix.ts` for testability.
- **Fixed self-trigger cooldown in change detection** (`beads-task-issue-tracker-6nm`): `lastProcessedAt` is no longer armed after every poll cycle completion — it is updated only via `notifySelfWrite()`. Eliminates the silent 3s window after each poll during which external CLI changes were dropped as self-triggered.
- **Search filter input now restores from localStorage on reload** (`beads-task-issue-tracker-rst`): the `<input type="search">` in the issues toolbar was bound to a local `searchValue` ref that initialized empty, while `filters.search` (persisted via `useProjectStorage`) restored from localStorage and silently re-applied to the table. After a reload the user saw an empty search field with an unexplained 3-row result instead of 1009. `searchValue` now initializes from `filters.value.search` so the input and the filter state agree on a single source of truth.
- **Settings dialog content no longer overlaps probe toggle** (`fix/settings-probe-toggle-overlap`): added `pr-10` padding to the content panel so scrollable content doesn't slide under the fixed toggle in the nav rail.
- **UpdateDialog changelog block hides horizontal scroll** (`fix/settings-probe-toggle-overlap`): added `overflow-x-hidden` to the changelog container so long lines don't produce an unexpected horizontal scrollbar in the update modal.

### Internal
- **Workflow Execution Style — section + inline reminders across 7 skills** (`beads-task-issue-tracker-hq6`): orchestrator kept asking "run next step?" at skill boundaries (e.g. after `supervisor DONE` → before `reviewing-code`) because the single-sentence rule in `CLAUDE.md` got lost to context-distance by the time the skill finished. Restructured: (a) `CLAUDE.md` now has a dedicated `### Workflow Execution Style` subsection with three numbered points — no intermediate questions including skill boundaries, table-format final report, filter long tool output; (b) each of the 7 workflow skills (`claiming-bead`, `pre-dispatch`, `land`, `merge-to-main`, `managing-epics`, `release`, `reviewing-code`) now carries an inline `> **Execution style** — см. CLAUDE.md § …` quote at the top, so the rule is injected into context every time a skill fires. Also fixed silent regression in `validate-epic-close.sh` uncovered by a detective audit: the PR-merge guard hard-coded `bd-<id>` branch lookup, so after the `u9v` rename (`fix/bd-<id>`) it was skipping the check for every bead; the hook now searches for any branch ending in `(bd-)?<id>` on origin. `session-start.sh` merged-branch check tightened with `--format='%(refname:short)'` + `grep -Fxq` so names with regex metacharacters (`feat/foo.bar`) match correctly.
- **Worktree branch naming — tolerant parser, Conventional namespace** (`beads-task-issue-tracker-u9v`): the previous rule that forced worktree branches to start with `bd-<bead-id>` was an ad-hoc workaround for a fragile basename+sed parser in `session-start.sh`. Reverted: `claiming-bead` Step 2.5 now recommends Conventional namespace (`fix/bd-<id>`, `feat/bd-<id>`, `docs/bd-<id>`, `chore/bd-<id>`, `refactor/…`, `perf/…`, `test/…`) — orchestrator picks the type by task, same as in sibling projects. `session-start.sh` auto-cleanup now reads the branch name via `git -C <worktree> branch --show-current` instead of stripping a `bd-` prefix from `basename`, so any naming scheme is recognised. Existing `bd-*` worktrees keep working.
- **`pnpm tauri:dev` now runs `scripts/predev.sh` pre-flight** (`beads-task-issue-tracker-hm5`): a stale Nuxt dev-server from a crashed prior session would hold port 3133, forcing the new Nuxt onto port 3000 while the Tauri webview still loaded 3133 → blank window. The pre-flight detects port 3133 holders via `lsof`, kills only those whose `cwd` belongs to this repo (foreign processes get a clear refusal instead of a kill), and additionally `pkill`s zombie copies of the dev binary scoped to its full path. Scoping protects the installed `/Applications/Beads Task-Issue Tracker.app` — both binaries share the executable name `beads-issue-tracker`, so an unscoped `pkill` would close the production app.
- **Worktree layout migrated to external parent** (`beads-task-issue-tracker-x3w`): worktrees now live under `~/Projects/worktrees/beads-task-issue-tracker/<branch>/` instead of `<repo>/.worktrees/`. External layout keeps repo `git status` clean, lets worktrees be removed physically without touching the repo, and gives hooks reliable CWD-based orchestrator/supervisor detection. Six hooks updated to the new path pattern: `lib/subagent-detect.sh`, `enforce-branch-before-edit.sh`, `session-start.sh`, `block-supervisor-close-and-signing.sh`, `block-orchestrator-tools.sh`, `memory-capture.sh`.
- **`scripts/setup-worktree.sh`** (`beads-task-issue-tracker-x3w`): new script that prepares a fresh worktree (`.env` symlink + `pnpm install` via pnpm global store). Cargo `target/` and Nuxt `.nuxt/` are intentionally not shared — symlinking `target/` breaks `cargo clean` (cargo#7510) and global `CARGO_TARGET_DIR` serializes parallel builds; `.nuxt/` is cheap to regenerate and shared access breaks concurrent `pnpm dev`.
- **`merge-to-main` skill now auto-lands feature branches** (`beads-task-issue-tracker-x3w`): Step 0 lists open feature-related beads and offers `AskUserQuestion` to close them in place (delegating `reviewing-code` or `bd close`). Step 0.5 detects a dirty working tree or an ahead-of-remote branch and delegates the `land` skill (commit + push via merge-slot) before `gh pr create`. The two-phase "run `/land` first, then merge" is gone.
- **`merge-to-main` documentation step — skip flag + auto-detect + DOCS REPORT** (`beads-task-issue-tracker-x3w`): skill recognizes skip-docs trigger phrases («без документации», «без доки», «no-docs», «skip-docs», «пропусти документацию»). When the flag is absent, an auto-detect pass checks whether the diff is limited to tests/config/docs-meta files with no new public APIs (`export`/`function`/`class`/Rust `fn`/`#[tauri::command]`) and whether any changed symbol is mentioned in `docs/` or `README.md`; if none, Step 3 is skipped automatically. Step 3 dispatch of `documentation-expert` now requires a mandatory `### DOCS REPORT` markdown table (status + commit SHA + file-by-file changes); after the agent returns, orchestrator always prints a factual markdown table sourced from `git log -1` + `git show --name-only` instead of trusting the agent's words.
- **`claiming-bead` skill recognizes worktree requests** (`beads-task-issue-tracker-x3w`): phrases like «в worktree», «создай worktree», «изолированно» trigger automatic `bd worktree create` + `setup-worktree.sh` provisioning in the external layout.
- **Hook-level shell tests** (`beads-task-issue-tracker-x3w`): added `.claude/hooks/tests/` with `test_helpers.sh`, `test_subagent_detect.sh` (6 cases, incl. legacy-layout negative), `test_shell_tokens.sh` (16 cases, incl. multiline quote-strip). Manual run: `bash .claude/hooks/tests/<file>.sh`.

## [2.3.0] - 2026-04-21

### Highlights
- **Full bd 1.0.x compatibility** — the app now speaks bd's new review chain, custom statuses, and three new issue types (`spike`/`story`/`milestone`).
- **Custom status colors in Settings** — pick any colour (solid or gradient) for every status; per-project, persisted locally.
- **Cmd+K cross-project command palette** — Linear/VS Code-style search across every project in the sidebar, with keyboard navigation and cross-project issue open.
- **No more phantom "Task deleted" toasts** when switching between projects — a long-standing annoyance on projects with different issue counts is gone.
- **Runtime language switcher** — Auto / English / Русский in Settings, with full UI localization (dashboard, issues, filters, dialogs, notifications).

### Added
- **Cmd+K cross-project command palette** (`beads-task-issue-tracker-nif.3`): Linear/VS Code-style search modal over all projects added to the sidebar. Cmd+K / Ctrl+K opens the palette; results are ranked by id-exact → last-segment id (e.g. `nif` matches `beads-task-issue-tracker-nif`) → id-contains → title-exact → title-contains → other fields. TTL cache 30s per open prevents redundant fan-out. Errors for individual projects are shown as a non-blocking badge. Focus-trap via Reka-UI Dialog; full keyboard navigation (↑↓ Enter Esc); cross-project select triggers project switch + issue open. Palette is positioned in the upper third of the screen with a 2-row result layout (id+title on first row, status+priority+project badges on second).
- **8-field toolbar search** (`beads-task-issue-tracker-nif.3`): shared utility `matchesSearch` extended search from 4 fields (id, title, description, labels) to 8 (+ workingNotes, acceptanceCriteria, designNotes, comments[].content). Both toolbar search and command palette reuse the same utility.
- **Debounce 180ms on toolbar search input** (`beads-task-issue-tracker-nif.3`): eliminates visual jitter when typing on large projects (1000+ issues × 8 fields). `watchDebounced` from `@vueuse/core` replaces the previous immediate watcher.

### Fixed
- **Command palette focus resets on query change** (`beads-task-issue-tracker-nif`): when typing in the palette search field, the focused result item now correctly resets to the first result instead of staying on a stale index.

### Changed
- **`bd_list` migrated to `bd export` on bd>=1.0** (`beads-task-issue-tracker-nif.2`): IPC command `bd_list` now uses version-gated path — `bd export` (JSONL) on bd>=1.0 or any br, `bd list --json` on bd<1.0. The export path returns all fields including `workingNotes`, `acceptanceCriteria`, `designNotes`, `comments` that were previously empty. JSONL parser (`parse_issues_jsonl_tolerant`) uses a whitelist (`_type` absent or `"issue"`) to filter out non-issue records (e.g. `_type: "memory"`). Server-side filters (`status/type/priority/assignee`) are applied on the Rust side via `apply_list_filters`. IPC contract `bd_list(options) -> Vec<Issue>` is unchanged.

### Changed
- **Global search bypasses active filters** (`beads-task-issue-tracker-kqc`): when the toolbar search field is non-empty, active `status/type/priority/assignee/label` filters and exclusions are ignored — matching Jira/Linear semantics so closed or filtered-out issues stay reachable. Search covers 4 fields: `id`, `title`, `description`, `labels[]` (case-insensitive substring). Fields `workingNotes/acceptanceCriteria/designNotes/comments` are not included because `bd list --json` does not return them; extending the set requires backend work — tracked as follow-up spike `beads-task-issue-tracker-du6`. Empty search preserves previous filter behaviour.

### Fixed
- **Flood of "Task deleted" toasts on project switch** (`beads-task-issue-tracker-dp9`): eliminated five sources of false notifications during project switch. The actual root cause (found via live instrumentation through Tauri MCP + chrome-devtools MCP): `watch` on persisted-per-project `filters` in `index.vue` — when switching projects, reactive filters reload from `useProjectStorage`, triggering `fetchIssues()` without protection; the diff between remaining `issues.value` from project A and fresh issues from project B is interpreted as a mass deletion. Additionally the `isProjectSwitch` guard was asymmetric — `addedIds > oldLen × 0.5` did not fire on big→small transitions (996 → 131, 131 < 498). Fixes: (1) `index.vue` — `fetchIssues(false, false, { skipNotifications: true })` in the filter watch handler; a filter change never implies task deletion. (2) `useIssues.ts` — symmetric guard `commonCount < BOTH.length × 0.5` covers both swap and big↔small. (3) `usePollScheduler` gained `stop()`/`resume()` — an inflight poll after stop no longer updates `lastPollEnd` nor calls `pollFn`. (4) `useChangeDetection.stop()` sets `abandoned=true` — inflight `onChanged` no longer reaches the UI. (5) `handlePathChange` calls `stopScheduler()/stopPolling()/await stopListening()` before the first async, and `resumeScheduler()` before `startListening()` (otherwise the first watcher event after switch was dropped). `fetchPollData` / `fetchIssues` gained a `{ skipNotifications: true }` option used by handlePathChange as an additional safety net. Verified by reproduction via MCP: before fix — `FIRED deleted=996`; after — `isProjectSwitch=true` on every diff, zero "deleted" toasts. 334/334 tests pass (green).


- **Hook escape hatches now work inline from the Bash tool** (follow-up of epic `a4q`): `CLAUDE_SKIP_STALE_CHECK=1 git commit ...` and `SKIP_ENRICH_CHECK=1 bd create ...` previously did not bypass hooks, because Claude Code launches the hook as a separate process BEFORE the Bash tool executes — the inline ENV prefix is visible only to the command's child shell, not to the hook. The `enforce-worktree-fresh-vs-main.sh` and `enforce-bead-enrichment.sh` hooks (Bash matcher) now additionally parse `COMMAND` for an inline prefix via a regex with shell-token boundaries. The env var set at the Claude Code process level keeps working as before. Found via a smoke test in a fresh session (see `.claude/plans/a4q-test-results.md` B6).

### Removed
- **`.claude/skills/react-best-practices/`** (`beads-task-issue-tracker-7g3`, child #5 of epic `a4q`): removed as irrelevant — the project uses Vue 3 / Nuxt 4. The React equivalent (should it ever be needed) is already available via the `vercel-react-best-practices` + `vercel-composition-patterns` plugins. Duplication eliminated.

### Changed
- **`.claude/skills/merge-to-main/SKILL.md`** (`beads-task-issue-tracker-7g3`): frontmatter description now explicitly separates `merge-to-main` from `land` — added the rule "do not invoke merge-to-main until the bead is reviewed + accepted". `subagents-discipline/SKILL.md` — sync skipped; our version (with the Iron Law section up top) is richer than the source.

### Added
- **5 orchestrator workflow skills + CLAUDE.md shrink** (`beads-task-issue-tracker-31p`, child #3 of epic `a4q`): ported the skills `claiming-bead` (claim-first on trigger phrases + auto Plan Mode), `pre-dispatch` (claim → collect BRANCH/START_COMMIT → ready-to-paste Task prompt; supervisor mapping adapted to our labels: frontend/ui/data/sync→vue-supervisor, backend/tracker→tauri-supervisor, ci/dx→test-supervisor), `land` (commit + push to the feature branch via merge-slot; separated from `merge-to-main` via trigger phrases), `managing-epics` (design doc → children with deps + acceptance → sequential dispatch; examples adapted for Tauri/Vue/tracker), `reviewing-code` (simplify via built-in `simplify` skill → two-stage code review → RAMS+WIG for every .vue → new Step 2.7 locale-sync check → acceptance via Tauri dev / chrome-devtools MCP / agent-browser → close --claim-next).

### Changed
- **CLAUDE.md shrunk from 174 to 142 lines** (child #3 of epic `a4q`): the "Bead Status Lifecycle", "Merge-slot for parallel sessions", "Session Completion", and "Before Merge to main" sections were compressed to links to skills/references; a new "Workflow Skills" section (5 bullets) was added. The ≤200-line architectural budget is kept with headroom. **`.claude/rules/frontend-reviews.md` rewritten**: supervisors no longer run RAMS/WIG (plugin skills are not inherited by subagents) — this is now an orchestrator step via the `reviewing-code` skill, Step 2.5. **`.claude/agents/vue-supervisor.md`** updated for the new workflow (the RAMS/WIG block replaced by a link). `.claude/rules/locale-sync.md`, `.claude/references/review-chain.md`, `.claude/references/bd-commands.md`, `.claude/beads-workflow-injection.md` — added links to the new skills. `.claude/agents/{tauri,test}-supervisor.md` — added a comment noting that the commit+push sequence is an inline version of `land`.

### Added
- **`block-git-add-all` hook** (`beads-task-issue-tracker-aas`, child #4 of epic `a4q`): ported from `invest_fund_sharks`. Blocks `git add -A`, `git add .`, `git add --all`, and `git commit -a` — forces listing files by name. Token-aware matching via `lib/shell-tokens.sh`: `bd add <id>` or quoted strings inside `bd comments add ... "git add ."` do not trigger false positives. Inserted second in `PreToolUse.matcher=Bash` (after `enforce-worktree-fresh-vs-main.sh`).

- **Bead enrichment hook + workflow templates** (`beads-task-issue-tracker-402`, child #2 of epic `a4q`): ported `enforce-bead-enrichment.sh` with two branches — the Bash matcher blocks `bd create` without `### Files` / `### Current state` / `### Target state` markers (exempt: `--type=epic`, `--ephemeral`, batch modes); the Task matcher blocks dispatch to `*-supervisor` without enrich + PLAN comment (exempt: `merge-supervisor`). Grandfathered via `INSTALL_DATE=2026-04-20`. Override: `SKIP_ENRICH_CHECK=1`. Adapted to the current bd version: `.comments` is absent from `bd show --json`, so `bd comments {ID}` is used for extraction. Added reference `.claude/references/workflow-templates.md` (heredoc template, PLAN comment, dispatch skeleton, phase-boundary). The `CLAUDE.md` "Enrich bead with context" section was compressed to a link to the reference + a description of the hook behavior.

- **Stale worktree guard + helpers** (`beads-task-issue-tracker-4ss`, child #1 of epic `a4q`): ported from `invest_fund_sharks`. New PreToolUse:Bash hook `enforce-worktree-fresh-vs-main.sh` blocks `git commit/cherry-pick/rebase/revert/merge` in a worktree that is behind `origin/main` when staged files overlap with changes in main (Frankenstein-commit risk). Soft reminder when behind without overlap. Escape: `CLAUDE_SKIP_STALE_CHECK=1`. Helpers `lib/shell-tokens.sh` (token-aware command matcher) and `lib/subagent-detect.sh` (CWD/transcript/marker-lock subagent detection). Reference `.claude/references/bd-worktrees.md` (when justified, commands, manual E2E). `.gitignore` extended with `.worktrees/`. `.claude/settings.json` — hook inserted first in `PreToolUse.matcher=Bash`.

- **SWR disk-cache warm-up on app cold start** (`beads-task-issue-tracker-t8x`): the stale-while-revalidate pattern, previously used only on project switch (`handlePathChange`), now also applies in `onMounted` — the app's first launch. Cold-open used to show a loading state for ~2.4s while the cold `bd list`/`bd ready` subprocess ran (see h90 numbers: spawn 1678ms + 717ms on Invest Sharks with 1001 issues). Now `app/pages/index.vue:onMounted`, before `fetchIssues()`, calls `warmUpFromCache(beadsPath.value)` → `applyWarmUpSnapshot` → `updateFromPollData(issues.value, cachedReady)` (same pattern as in `handlePathChange:502-523`). If a fresh PollData snapshot exists on disk (`<os-cache>/com.beads.manager/poll/poll-<hash>.json`, TTL 1 hour) — the UI renders instantly (~50ms ipc), while `fetchIssues+fetchStats` quietly pull fresh data in parallel. No generation guard is needed in `onMounted` (there is no concurrent caller like in switch). The `[perf:app_boot]` log is extended with `warmup=Xms warmedFromCache=true|false` fields. Trade-off: for the first second the user may see a slightly stale state (e.g. an issue closed via `bd close` in the terminal will flicker before refreshing). This is acceptable — a standard industry SWR pattern (Linear, Gmail, Vercel's SWR library). Related to `ydr` (batched `fetchPollData` in `onMounted`) — tracked as a separate bead. 326/326 tests pass (green), `vue-tsc --noEmit` exit 0.

### Internal
- **Performance instrumentation for project switch + poll** (`beads-task-issue-tracker-8ug`): added `performance.now()` / `Instant::now()` markers at key points to diagnose 5-second delays on a project with ~1000 issues. Backend (`src-tauri/src/lib.rs:bd_poll_data`): phases split into `spawn_ms` (bd subprocess), `parse_ms` (JSON parse), `transform_ms` (`transform_issue` loop), `total_ms`; `[perf:bd_poll_data]` log at `debug` level (high-frequency polling). A separate `[perf:dolt_coldstart] path=... init_ms=...` log at `info` level fires once per project per process via `DOLT_COLDSTART_LOGGED: LazyLock<Mutex<HashSet<String>>>` (pattern identical to `LAST_KNOWN_MTIME`). Frontend (`app/composables/useIssues.ts`): `[perf:fetchPollData] ipc=... process=... total=... count=...` at `debug`; `[perf:warmUpFromCache] ipc=... process=... total=... count=... hit=true|false` at `info` (rare project-switch event). `app/pages/index.vue:handlePathChange` — added `perfWarmup`, `perfClearState` markers; extended final log `[perf:handlePathChange] warmup=... clearState=... pre-flight=... fetchIssues=... fetchStats=... total=... warmedFromCache=...`. No production effect — pure diagnostics for the upcoming `beads-task-issue-tracker-h90`. 326/326 tests pass (green), `vue-tsc --noEmit` exit 0, `cargo check` exit 0.

### Added
- **Stale-while-revalidate PollData disk cache** (`beads-task-issue-tracker-9id`): on project switch, the screen no longer goes blank for several seconds. After a successful `bd_poll_data`, the backend writes a raw `Vec<BdRawIssue>` snapshot (open + closed + ready) in the background to `<os-cache>/com.beads.manager/poll/poll-<hash>.json` via `std::thread::spawn` (fire-and-forget). The project hash is the same djb2 algorithm from `app/utils/hash.ts`; the Rust implementation `hash_path_djb2` uses `encode_utf16()` for parity with JS `charCodeAt` on non-ASCII paths (verified across 5 paths, including Cyrillic `/Users/максим/project` and surrogate-pair emoji `/tmp/🚀/repo`). TTL 1 hour — anything older is ignored. New Tauri command `bd_poll_data_cached(cwd)` reads the cache and runs it through `transform_issue`, returning `Option<PollData>`. Frontend: `bdPollDataCached()` in `app/utils/bd-api.ts` + a pure `warmUpFromCache(cwd)` in `useIssues.ts` (returns a snapshot without mutating reactive state) + synchronous `applyWarmUpSnapshot`. `handlePathChange` in `app/pages/index.vue` checks the generation guard **before** mutating state after `await warmUpFromCache` (closes the race on fast switch A→B→C); if a snapshot exists — we skip `clearIssues()`/`clearStats()` and immediately show the last slice; `fetchPollData()` will quietly replace it with fresh data in parallel. Extracted shared `linkParentsAndChildren(issues)` into `app/utils/issue-helpers.ts` — eliminated ~120 lines of duplication across `fetchIssues`/`fetchPollData`/`warmUpFromCache`. 326/326 tests pass (green) (+5 parity cases for `hashPath`, +3 for `linkParentsAndChildren`), `vue-tsc --noEmit` exit 0, `cargo check` exit 0.
- **Deferred + In Review KPIs on the dashboard + Open → Ready** (`beads-task-issue-tracker-6pg`): a user noticed that deferred (`deferred`) tasks were invisible in the quick stats. Research of Linear / Jira / Asana / Height / ClickUp showed that every major tracker surfaces Waiting/On Hold and In Review as dedicated metrics. Added 2 new cards: **In Review** (aggregate review-chain counter: `inreview`+`simplified`+`reviewed`+`accepted`, with a dedicated violet token `--color-status-inreview` — `#a855f7` dark / `#7c3aed` light) and **Deferred** (`status==='deferred'`, amber `--color-status-deferred`); clicking activates the corresponding filters in the table. Additionally renamed **Open → Ready** — the `stats.open` metric already counts only `open && !blockedBy`, so "Open" was misleading. 7 KPI cards total, in the order Workflow → Ready → In Progress → In Review → Blocked → Deferred → All, fit in the sidebar across 2 rows via `flex-wrap`. `DashboardStats` extended with `inReview: number` and `deferred: number` fields (`app/types/issue.ts`); `computeStatsFromIssues` (`app/utils/issue-helpers.ts`) increments them after the `isIssueBlocked` check. `KpiFilter` in `DashboardContent.vue` and `pages/index.vue` extended symmetrically; `activeKpiFilter` recognises the review-status Set via `isStatusSetEqual`. i18n: `dashboard.kpi.{ready,inReview,deferred}` added to `en.json` + `ru.json` (EN: Ready/In Review/Deferred, RU: Готовы/На ревью/Отложены); the `kpi.open` key was renamed to `kpi.ready`. 318/318 tests pass (green), `vue-tsc --noEmit` exit 0.

### Internal
- **`locale-sync` rule for agents** (`beads-task-issue-tracker-2e1`): the i18n rule is now formalised following the `logging` pattern — triple delivery in the rules architecture. L3 rule `.claude/rules/locale-sync.md` with `paths: app/**/*.{vue,ts}` + `i18n/locales/*.json` (source of truth: `$t()`-only in UI, naming convention aligned with existing namespaces `about`/`app`/`common`/`dashboard`/`details`/`issues`/`layout`/`menu`/`notifications`/`page`/`settings`, mandatory en↔ru sync via `jq -S 'paths(scalars)' | diff`, explicit list of what is NOT translated — user content / bd identifiers / file names / native macOS menu). L1 line in `CLAUDE.md` next to Logging. A bullet in `.claude/agents/vue-supervisor.md` under Standards — so the rule reliably reaches the subagent at dispatch time (root CLAUDE.md is not auto-injected into the subagent, and rules with `paths:` do not fire on Write of a new file). Rejected alternatives: a dedicated i18n-specialist subagent (overkill for 2 locales, we have no separate translator role); an L5 hook (educational value = 0, blocks without explanation); nested `app/CLAUDE.md` (too early for a single rule).

### Changed
- **KPI labels back to English + metric-explainer tooltips** (`beads-task-issue-tracker-5n8`): visual review of the previous commit exposed a grid issue — Russian labels ("ЗАБЛОКИРОВАННЫЕ") are wider than English and break card alignment. Research of dev-first trackers (Linear, Height, Vercel, Sentry, Arc, Raycast) showed they all keep statuses in English. The Russian `dashboard.kpi.*` values in `ru.json` were reverted to English (Workflow/Ready/In Progress/In Review/Blocked/Deferred/All) — matching the table's status badges, which already render via `useStatuses.ts`. Added namespace `dashboard.kpi.tooltip.*` (7 keys, EN + RU) with technical metric explanations (Vercel/Stripe/Mixpanel pattern — metric-explainer tooltip). `KpiCard.vue` extended with optional `tooltip?: string` prop: when passed, the button is wrapped in shadcn `<Tooltip>`/`<TooltipTrigger>`/`<TooltipContent>`; otherwise it renders as before without a wrapper. `DashboardContent.vue` and `pages/index.vue` — KPI card blocks wrapped in `<TooltipProvider>`, `:tooltip` plumbed through all 7 cards. 318/318 tests pass (green), `vue-tsc --noEmit` exit 0, locale-sync diff empty.
- **Settings dialog redesign — sidebar navigation + inline feedback** (`beads-task-issue-tracker-fq7`): the settings dialog grew to 6 sections (Theme, Language, CLI Client, Display, Status Colors, Probe) and no longer fit in `sm:max-w-lg` without a long scroll. When attempting to switch from `bd` to `br`, the `switchResult` error rendered at the very bottom of the dialog — the user did not see it and thought the switch "did not work". This violated `.claude/rules/ui-constraints.md` ("MUST show errors next to where the action happens"). `SettingsDialog.vue` rewritten around a `sm:max-w-3xl` layout with `grid grid-cols-[180px_1fr]`: sidebar navigation on the left (lucide icons + labels + `aria-current="page"` + `focus-visible:ring`), content of the active section on the right. Each of the 6 sections extracted into its own component under `app/components/layout/settings/`: `SettingsAppearance.vue` (Theme + Language together — both are about appearance), `SettingsCliClient.vue` (with `switchResult` and `isSwitching` spinner right beneath the `bd`/`br` buttons, `role="status" aria-live="polite"`), `SettingsDisplay.vue`, `SettingsStatusColors.vue` (internal section scroll — the outer grid does not grow beyond `max-h-[80dvh]`), `SettingsProbe.vue` (dev-only). The active section is persisted in `useLocalStorage('beads:settingsTab')`. Composables (`useTheme`/`useLocale`/`useStatuses`/`useStatusColorOverrides`/`useIssues`/`useCliClient`) untouched. RAMS fixes in the same iteration: the probe URL received a `<label class="sr-only">`, the probe toggle became `role="switch" aria-checked` (instead of `aria-pressed`), theme cards and `bd`/`br` received an explicit `focus-visible:ring`. New i18n block `settings.sections.{appearance,cli,display,colors,probe,navigationLabel}` + `settings.probe.urlLabel`. Additional dev-only hook `window.__openSettings` in `app.vue` (under `import.meta.dev`) — for future UI verification via Tauri MCP. 318/318 tests; `vue-tsc --noEmit` exit 0; visual verification via Tauri MCP — all 5 sections render, sidebar switching works, and on `bd` → `br` the "'br' not found" message appears right beneath the buttons.

### Fixed
- **Faster project switch — eliminated duplicate `bd ready`** (`beads-task-issue-tracker-8ow`, `-9oc`): on project switch, `handlePathChange` in `app/pages/index.vue:523-525` did two sequential `bd` cold-starts: first `fetchIssues()` via `bdPollData` (batched `bd list --all` + `bd ready`), then `fetchStats(issues.value)` called `bdReady` again in `useDashboard.ts:49` (prefetchedReady was not threaded through). For Dolt projects, every cold-start spins up an embedded `dolt sql-server` (~2–5s), so this saves one extra server launch per switch. Fix: migrated to the existing `fetchPollData()` + `updateFromPollData(issues.value, readyData)` pattern (exactly the one already used in polling, `pages/index.vue:232-236`). In parallel, added `performance.now()` markers for all four phases (pre-flight / fetchIssues / fetchStats / total) — logged via `logFrontend('info', '[perf:handlePathChange] ...')` into `beads.log`, so future optimisation wins can be measured objectively (the SWR disk-cache `-9id` remains an open item). 318/318 tests pass (green), `vue-tsc --noEmit` exit 0.
- **Workflow KPI now includes blocked tasks** (`beads-task-issue-tracker-epd`): the `Workflow` counter on the dashboard showed fewer tasks than the filter applied on click. Root cause — inconsistency: `isIssueWorkflow()` in `app/utils/issue-helpers.ts` explicitly excluded blocked via `!isIssueBlocked(issue)`, while `computeWorkflowStatuses` (used by the filter) included blocked because `blocked` belongs to the `wip` category and `WORKFLOW_CATEGORIES = {active, wip, frozen}`. Under the common interpretation (Jira et al.), workflow = everything except done, and blocked tasks are part of the work stream. Fix: `isIssueWorkflow()` now returns `true` for every status except `closed`/`deleted`/`tombstone`; `stats.blocked` / `stats.open` / `stats.inProgress` stay as before (the `if (isIssueBlocked) … else switch(status)` block correctly routes non-workflow buckets). 3 tests in `tests/utils/dashboard-stats.test.ts` + 1 in `tests/utils/issue-helpers.test.ts` updated for the new behaviour (workflow=5 instead of 3 in the 8-issue case, default filter view includes blocked). 318/318 tests pass (green), `vue-tsc --noEmit` exit 0.
- **Language selector in Settings dialog responds to clicks** (`beads-task-issue-tracker-5xr`): shadcn/reka-ui `Select` component inside the Settings `Dialog` ignored clicks — the trigger button never opened its popover (`aria-expanded` stayed `false`, portal content never mounted). Root cause is the known conflict between reka-ui `DialogContent`'s focus trap and `SelectContent`'s teleported portal — neither pointerdown, click, nor keyboard events opened the dropdown. Replaced the `Select` with three native radio inputs (Auto / English / Русский) wrapped in labels styled to match the theme. Native radio has no portal dependency, participates in the dialog's focus trap naturally, and is also what `spec-i18n-en-ru-ui.md` task 5 originally called for ("radio (Auto/English/Русский)"). Removed unused `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue` imports.

- **Russian locale actually loads at runtime** (i18n epic sgx, task 14 manual QA): `@nuxtjs/i18n@10.2.4` only preloads `defaultLocale=en` at boot — `ru` messages are lazy. `useLocale.ts` was setting `i18n.locale.value = 'ru'` via `vue-i18n`'s composer directly, which bypasses the Nuxt-attached `setLocale()` that triggers the lazy bundle loader. Result: when `navigator.language=ru`, the app loaded the `ru` locale code but had zero translated messages — every `t('page.dashboard')` call fell through to the raw key literal on screen. Fix: detect the Nuxt-attached `setLocale()` method on the composer and use it when present; keep the direct-assignment fallback for unit tests running outside Nuxt. Also set `lazy: false` explicitly in `nuxt.config.ts` as a belt-and-suspenders preload. All 6 acceptance scenarios from the spec now pass: sys=ru → Дашборд, sys=de → Dashboard fallback, explicit override en + reload → EN, Auto + reload → system, runtime ru↔en without reload, StatusBadge text="open" / aria-label="Status: open" / "Статус: open".
- **Escape `@` in `dashboard.prerequisites.content`** (i18n epic sgx, task 14 manual QA): `@beads/cli` in the markdown snippet was interpreted by `@intlify/message-compiler` as a linked-message reference (`@:key.name`), failing compilation with `Invalid linked format (error code: 10)` and breaking every `vue-i18n` lookup. Replaced with the documented literal-escape `{'@'}beads/cli`, which the compiler renders as `@beads/cli` at runtime. Pre-existed since task 7 (dashboard batch) but was dormant because the dev-server overlay was never surfaced during those mechanical commits.

### Added
- **Final locale sweep — dialogs, notifications, shadcn primitives** (i18n epic sgx, task 13): three migration dialog bodies in `pages/index.vue` (Database Repair Required, Database Migration Required, Attachment Update Required — deliberately left in English in task 10-12) now fully localized. New namespace `page.dialogs.{repair,migration,attachmentRefs}` with intro prose, bullet steps, progress/error templates, and action buttons (Later → `common.later`, Repair All/Repair This Project/Repairing…, Migrate Now/Migrating…, Update Now/Updating…). Migration steps with inline `<code>bd init</code>` / `<code>bd import</code>` render via `<i18n-t>` slots instead of `v-html` to avoid XSS (per spec Ask First). `attachmentRefs.counter` uses 4-form Russian pluralization (zero/one/few/many). All 24 `notifySuccess`/`notifyError` calls in `useIssues.ts` + `useIssueDialogs.ts` now resolve via new top-level `notifications.*` namespace (issue closed/reopened/deleted + failures, epic deleted, dep/relation add/remove + failures, unblocked-by-close with one/many forms, multi-delete counter with RU plural forms). `notifyStatusTransitions` now takes `t` as a parameter since it's called from the `useIssues()` body. Shadcn `<span class="sr-only">Close</span>` in `DialogContent.vue` / `DialogScrollContent.vue` / `SheetContent.vue` now reads `common.close`, and `MarkdownPreviewDialog.vue` search placeholder reads `common.searchInDocument`. Spec grep (`>\s*[А-Я][а-я]+|>\s*[A-Z][a-z]+\s*<`) is now empty across `app/components`. jq-symmetry verified; 318/318 tests; vue-tsc clean.

### Fixes
- **Remove dead `isSearchActive` prop binding** in `app/pages/index.vue`: the computed `isSearchActive` (line 715) and its two `:is-search-active` bindings on `IssueListPanel` (lines 983, 1208) were inherited from an upstream cherry-pick but never consumed anywhere — `IssueListPanel.vue` did not declare it in `defineProps`, and no child component read it. Surfaced as a Vue warning (*"Extraneous non-props attributes (is-search-active) were passed to component but could not be automatically inherited because component renders fragment or text or teleport root nodes"*) that became more visible after the Nuxt 4.4.2 upgrade. Deleted both bindings and the computed

### Internal
- **Baseline locale structure in `i18n/locales/`** (i18n epic sgx, task 4): `en.json` and `ru.json` expanded from placeholders to cover three top-level namespaces (`app`, `common`, `settings`) with all keys translated in both locales. `common.*` covers the reusable primitives (ok/cancel/save/delete/close/confirm/loading/error/retry/yes/no). `settings.language.*` is ready for SettingsDialog integration (task 5 — auto/english/russian labels + description). New `i18n/locales/README.md` documents naming conventions (namespace.subnamespace.element), fallback policy, what NOT to translate (bd identifiers, user content, Rust backend, native macOS menu items), and includes a `jq`-based symmetry check snippet. Locale key sets verified identical via `diff <(jq paths ...) <(...)`.
- **Install @nuxtjs/i18n@10.2.4**: infrastructure for upcoming EN+RU localization (epic sgx). No user-facing change yet — locale JSON files are placeholder stubs. Wired via `nuxt.config.ts` with `strategy=no_prefix`, `defaultLocale=en`, `fallbackLocale=en`, `detectBrowserLanguage=false`. Locale files live in `i18n/locales/` (the default `restructureDir`/`langDir` path for @nuxtjs/i18n v10). Next: `useLocale` composable with auto-detect + persistence (task 2).

- **Nuxt upgrade 4.3.0 → 4.4.2**: preparation step for adding `@nuxtjs/i18n@10.2.4` (i18n EN+RU support), which requires `@nuxt/kit ^4.4.2`. Side effect: `vue-router` is now transitively provided by Nuxt at v5.0.4 (previously pinned direct dep at `^4.6.4`); the direct dependency was removed from `package.json` because no code in `app/` imports `vue-router` directly. Smoke-tested: 294/294 unit tests pass, `vue-tsc --noEmit` exit 0, `pnpm build` completes (client 9s + server 64ms + nitro prerender 0.4s). No code changes — `package.json` + `pnpm-lock.yaml` only
- **Extract `formatDate` + `formatTime` into `app/utils/date-format.ts`** (i18n epic sgx, task 3): duplicated inline formatters in `IssueTable.vue` and `IssuePreview.vue` are now shared locale-aware utilities. Both call sites updated to pass locale from `useLocale()`. `formatDate` uses `{year: 'numeric', month: 'long', day: 'numeric'}` — visible change for English users (was short `dd.mm.yyyy`, now long "April 19, 2026"), in exchange for correct Russian formatting ("19 апреля 2026 г."). `formatTime` uses `{hour: '2-digit', minute: '2-digit'}` — locale-aware AM/PM vs 24h. Preserved the time component in IssuePreview (was being lost in the initial refactor). 8 new unit tests cover both locales, invalid inputs, Date-object input, defaults.
- **CLAUDE.md decomposed into a 5-level lazy-loaded system** (DX refactor, no user-facing change): root `CLAUDE.md` shrunk from 374 → ~175 lines. Cross-cutting rules moved to `.claude/rules/` with `paths:` frontmatter so they auto-load on `Read` of matching files (`logging.md` for `app/**/*.{ts,vue}` + `src-tauri/src/**/*.rs`, `frontend-reviews.md` for Vue components, `ui-constraints.md` for UI primitives). Rust/Tauri specifics moved to nested `src-tauri/CLAUDE.md`. Six new references under `.claude/references/` (bd-commands, release-workflow, orchestration, review-chain, plan-mode, rules-architecture). All 11 supervisor agent bodies got a pointer to `rules-architecture.md` so subagents — which do not inherit orchestrator memory — can find the decision tree for new rules. `.claude/frontend-reviews-requirement.md` and `.claude/ui-constraints.md` were moved into `.claude/rules/`; `.claude/agents/discovery.md` refs updated transactionally in the same commit so the discovery workflow keeps working

### Added
- **Localize pages/index.vue, ui primitives, composables** (i18n epic sgx, tasks 10-12): `ConfirmDialog` defaults now fall back to i18n keys via `computed()` (props default to empty string, effective value resolves from `t('common.confirm')`/`t('common.areYouSure')`/etc). `NotificationToast` unchanged — displays caller-provided messages. `useAppMenu` native Tauri menu built via `t('menu.*')` with a locale `watch(locale, buildMenu)` that rebuilds the menu on language change (addresses spec Ask First trigger: Tauri native menu rebuild is now done by invoking `Menu.new()` + `setAsAppMenu()` after initial build rather than one-shot). `useUpdateChecker` fallback error strings ("Failed to check for updates", "Failed to download update") pulled from `common.*` keys. `pages/index.vue` — sidebar labels (Dashboard/Details), sidebar toggle tooltips, Failed-to-load banner, Loading fallback, editContext header ("New issue"/"Editing"), "Select an issue to view details" (both occurrences), footer tooltips (Toggle Debug / Settings / Probe), Probe badge, Sync Error dialog, KPI cards (now delegate to `dashboard.kpi.*` keys instead of hardcoded titles — removes duplication with `DashboardContent`), and 9 notification toasts (Issue created/saved, Failed to save, Comment added/failed, Attachments migrated/updated, DB repaired/failed, Migration complete) with `{count}` / `{success}` / `{failed}` placeholder interpolation. Dolt migration / Database repair / Attachment refs migration *dialog bodies* left in English in this batch — they fire once per project lifetime and have many multi-paragraph explanations; they are tracked as follow-up scope outside epic sgx. New namespaces: `page.*`, `menu.*` + `common.updateCheckFailed`/`common.downloadFailed`/`common.areYouSure`. jq-symmetry verified; 318/318 tests; vue-tsc clean.
- **Localize Details components** (i18n epic sgx, task 9): 4 files in `app/components/details/` — `IssueDetailHeader.vue` (Pin/Unpin/Edit/Reopen/Close/Delete buttons), `CommentSection.vue` (heading with `{count}` interpolation, TOC tooltip, empty state, textarea placeholder, submit button), `IssueForm.vue` (Type/Status/Priority/Parent/Title/Description/Assignee/Labels/External Reference/Spec ID/Estimate/Design Notes/Acceptance Criteria/Working Notes labels + placeholders; Type/Status/Priority option arrays converted to `computed(() => [...])` reusing `issues.typeLabels/statusLabels/priorityLabels`; Cancel/Create/Save/Saving footer buttons), `IssuePreview.vue` (15 section headers, attachment section with Attach/No-attachments/dashboard-attachments, Description/Parent/Children with Create-child button, External Reference, Details with Assignee/Labels/Created/Started/Updated subheaders + empty states, Dependencies + Add-blocker + Blocked By/Blocks subheaders, Relations + Add-relation + localized relation-type labels via `getRelationLabel()` helper that maps to `details.relationTypes.<type>` and falls back to title-case, Estimate/Design Notes/Acceptance Criteria/Working Notes/Metadata/Spec ID section headers, unassigned/no-children/no-attachments/no-labels empty states, description fallback). New namespace `details.*` with subnamespaces header/sections/actions/empty/form/comments/relationTypes. jq-symmetry verified; 318/318 tests; vue-tsc clean.
- **Localize Issues components + badge aria-labels** (i18n epic sgx, task 8): mechanical batch of 15 files in `app/components/issues/`. Badges: `StatusBadge`/`PriorityBadge`/`TypeBadge`/`LabelBadge` gain localized `aria-label` (spec acceptance: "Status: open" / "Статус: open"). The visible badge text (bd identifier like `open`, `P0`, `BUG`) stays untranslated per spec — only the aria-label announces in the user's language. `StatusBadge` tooltip "Blocked by X, Y" now uses `t('issues.badges.blockedBy', { ids })`. Filter dropdowns (`AssigneeFilterDropdown`/`LabelFilterDropdown`/`StatusFilterDropdown`/`TypeFilterDropdown`/`PriorityFilterDropdown`): trigger labels, tooltip hints, empty states. `ExclusionFilterDropdown` — trigger sr-only label, tooltip, header "Hide Issues", 5 section headers, "Clear all exclusions" button, and statusOptions/priorityOptions/typeOptions.label arrays converted to `computed(() => [...])` pulling from `t()` so locale switches immediately. `FilterChips` — "Filters:" / "Hidden:" section labels + 2 Clear buttons. `IssuesToolbar` — multi-select sr-only/tooltip, search placeholder, delete sr-only, New button, selected-count text using pluralization (`t(key, params, count)`). `ColumnConfig` — column settings sr-only/tooltip, "Visible Columns" header, per-column label mapped via `columnLabel(col)` helper that falls back to stored `col.label` if the `issues.columns.<id>` key is missing, "Reset to defaults" button. `IssueTable` — column-header labels via same `columnLabel(col.id, col.label)` helper (keeps stored labels as fallback for migrated localStorage data), empty-state "No tasks / issues found", closed-children tooltip with pluralization, Load-more button with `{remaining}` interpolation. `IssueListPanel` unchanged — it's a pass-through component. New namespace `issues.*` with subnamespaces badges/columns/toolbar/filters/priorityLabels/typeLabels/statusLabels/table. Russian pluralization uses the 3-form CLDR schema (one/few/many: "Выбрана 1 задача | Выбрано 2 задачи | Выбрано 5 задач"). jq-symmetry verified; 318/318 tests; vue-tsc clean.
- **Localize Dashboard components** (i18n epic sgx, task 7): mechanical batch of 10 files in `app/components/dashboard/`. `DashboardContent.vue` — 5 KPI card titles (Workflow/Open/In Progress/Blocked/All) passed via props to `KpiCard`, 5 section headers (Charts/In Progress/Blocked/Check This Out/Ready to Work), pinned-sort tooltip tri-state, "Loading..." fallback. `OnboardingCard.vue` — title, description, Browse button. `PinnedList.vue` — "No pinned issues" empty state. `QuickList.vue` — "No issues ready to work on" empty state + per-issue copy-ID tooltip/aria-label with `{id}` interpolation. `StatusChart.vue` — title + Open/Closed axis labels. `PriorityChart.vue` — title only (P0-P4 labels are identifiers, not translated per spec). `FolderPicker.vue` — dialog title + description, Home/Parent folder/Go tooltips, path input placeholder, Beads Project badge, Added badge, Loading/No subfolders fallbacks, beads label, Cancel/Open/Add Project footer buttons, load-error fallback string. `PathSelector.vue` — Select Project button, Projects section header, sort tri-state tooltip (A-Z/Z-A/Manual), Reset tooltip, probe-expose toggle tooltips (Exposed/Not exposed), Remove project confirm dialog with `{name}` interpolation (no string concat), Probe Expose dialog with dynamic title + description computed from `isExposed()` state. `PrerequisitesCard.vue` — welcome title + subtitle + full markdown content (Install CLI / Initialize / Create first issue / Learn more) now lives in locale files and is returned via `computed()` so it re-resolves on locale change. `KpiCard.vue` unchanged — receives `title` as a prop, consumer `DashboardContent` feeds it `t('dashboard.kpi.*')`. New namespace `dashboard.*` with subnamespaces kpi/sections/pinnedSort/charts/lists/onboarding/folderPicker/pathSelector/prerequisites. Removed string concatenation in `exposeDialogDescription` and the inline `Are you sure you want to remove '${projectToRemoveName}'` template binding — both now use `t(key, { name })` placeholder interpolation (spec Ask First: variable-in-middle-of-string is resolved via i18n placeholders, not concatenation). jq-symmetry verified; 318/318 tests; vue-tsc clean.
- **Localize layout dialogs** (i18n epic sgx, task 6b): completes task 6. Mechanical batch of 5 dialog/panel components. `DialogsLayer.vue` — every confirm/cancel string across 8 dialogs (Delete, Epic delete with children, Close, Detach attachment, Remove dependency, Add blocker, Add relation, Remove relation, Markdown save). `DebugDialog.vue` — title, Live/Paused/Refresh/Bottom/Clear buttons, "No logs yet". `DebugPanel.vue` — tab labels (Logs/Pipeline), toolbar buttons (Live/Paused/Refresh/Bottom/Verbose ON/OFF/Clear/Export/Force Sync), all pipeline diagnostics labels (Watcher/Scheduler/Poll execution/Mtime check + counter names), Dolt tooltip, bd-CLI-update tooltip. `UpdateDialog.vue` — title, Demo badge, loading/error/up-to-date/update-available states, current/latest version labels, macOS xattr note, copy-to-clipboard tooltip, Download & Quit / View on GitHub / Later / Close footer buttons. `SettingsDialog.vue` — remaining strings: dialog title+description, Theme label, CLI Client section (title + br/bd descriptions + "Switching client..."), Display Options, Status Colors section (title, description, Loading, Color/From/Grad labels, Reset button, color/gradient tooltips + aria-labels, category headers), Probe section (title, aria-label, description, Test connection button, Connected/Disconnected status). New namespaces: `layout.dialogs.*` (delete/epicDelete/closeIssue/detach/removeDep/addBlocker/addRelation/removeRelation/markdownSave), `layout.debug.*` (live/paused/refresh/bottom/clear/export/verbose/on/off/noLogs/forceSync/syncing/reset/uptime + tabs + pipeline.* + doltTitle + updateAvailable/updateReleases), `layout.update.*` (title/demo/checking/failed/downloading/available/currentVersion/latestVersion/macosNote/copied/clickToCopy/upToDate/latestVersionText/downloadAndQuit/viewOnGitHub/later), `settings.cliClient.*` / `settings.display.*` / `settings.statusColors.*` / `settings.probe.*`. Added `common.remove` + `common.reset`. `EpicDelete.hasChildren` uses `<i18n-t>` component with named slots to preserve the `<span class="font-medium text-sky-400">` styling on the issue title — no `v-html` used anywhere (XSS constraint from spec). jq-symmetry check passes; 318/318 tests green; `vue-tsc --noEmit` exit 0.
- **Localize AppHeader + AboutDialog** (i18n epic sgx, task 6a): first batch of layout-component localization. `AppHeader.vue` tooltips ("Zoom in", "Zoom out", "Refresh") and the app title fallback now go through `$t()`; `AboutDialog.vue` app title, version line, and footer attribution lines are all localized. New locale keys: `common.refresh`, `layout.header.zoomIn`, `layout.header.zoomOut`, `about.version` (with `{version}` interpolation), `about.poweredBy`, `about.vibeCoded`. `CollapsibleSection.vue` and `UpdateIndicator.vue` have no hardcoded user-facing strings — unchanged. Dialog-heavy components (DialogsLayer, DebugDialog, DebugPanel, UpdateDialog, remaining SettingsDialog bits) defer to task 6b.
- **Language switcher in Settings** (i18n epic sgx, task 5): new section in SettingsDialog (between Theme and Display Options) with a Select control listing Auto, English, Русский. Auto mode derives the locale from `navigator.language` (ru-* → Russian, anything else → English); the current effective language is shown in parentheses next to "Auto" for clarity. Selecting Русский or English explicitly persists `'ru'`/`'en'` to `localStorage['beads:locale']` via `useLocale().setLocale()`; selecting Auto clears the key. Changes apply immediately via vue-i18n reactivity — the Language section itself re-renders in the new language even before other UI strings are localized in subsequent tasks.
- **`useLocale` composable** (i18n epic sgx, task 2): single source of truth for current UI language. Auto-detects `ru` when `navigator.language` starts with `ru` (handles `ru-RU`, `ru-BY`, `ru`, etc.), otherwise falls back to `en`. Persisted to `localStorage` under key `beads:locale` as plain string — absent/null means auto mode, `'en'`/`'ru'` means explicit choice. Reactive: `setLocale('auto' \| 'en' \| 'ru')` mutates `vue-i18n` locale immediately and persists. Invalid localStorage values are ignored and trigger re-resolution via `navigator.language`. Module-level singleton shared across all callers (same pattern as `useTheme`). 9 unit tests cover I/O Matrix scenarios from the i18n spec (fresh install on RU/EN/DE system, locale variants `ru`/`ru-RU`/`ru-BY`, explicit override, reset-to-auto, corrupt localStorage, persist, vue-i18n sync). `vue-i18n@11.3.2` added to devDependencies so Vitest can resolve the mocked import without fragile pnpm store paths. Next: integrate into Settings dialog (task 5).
- **"Float active tasks to top" sort option** (`beads-task-issue-tracker-kop`): when enabled (default ON), tasks in the `wip` status category — both built-in (`in_progress`) and custom review-chain (`inreview`, `simplified`, `reviewed`, `accepted`, plus any user-defined custom status whose bd category is `wip`) — float to the top of the table regardless of the user's sort field, addressing the UX issue where active work sank under stale `open` tasks sorted by `updatedAt DESC`. Reuses the existing bd category plumbing (`useStatuses().getMeta(name).category`) rather than inventing a parallel taxonomy, so no detection or mapping layer was needed — any custom status the user defines with `bd statuses` works out of the box. `sortIssues()` gained an optional `options: { floatActive, resolveCategory }` param and a new `categoryRank` export (`wip:0, active:1, frozen:2, done:3`); the category tier slots between pinned (tier 1) and user-sort (tier 3). Unknown statuses fall back to `active` rank, consistent with `StatusBadge.vue:43`. The toggle is persisted per-project via `useProjectStorage('floatActiveToTop', true)` and exposed in SettingsDialog → Display Options. Design-wise, this implements the UX pattern documented by Linear (Focus view, "started" state category) and Jira (In Progress status category rolling up custom statuses). 6 new unit tests in `tests/utils/issue-helpers.test.ts` cover toggle off/on, category rank ordering, unknown-status fallback, pinned-above-wip, intra-partition user-sort, and backward-compat when `options` is omitted
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

- **Workflow filter now covers all in-flight statuses, including custom and `blocked`** (`ud2`): the Workflow KPI filter set is now derived from bd status categories (`active`/`wip`/`frozen`) via `useStatuses()` instead of a hardcoded five-status list. Review-chain statuses (`inreview`, `simplified`, `reviewed`, `accepted`), `blocked`, and any custom `wip` status are automatically included in the Workflow view. Also corrected the `BUILTIN_FALLBACK` categories for `blocked` (was `active`, now `wip`), `pinned` (was `active`, now `frozen`), and `hooked` (was `active`, now `wip`) — the fallback is used during cold-start before bd statuses are loaded. **Upgrade note:** if the Workflow filter appears incomplete after updating, click the Workflow KPI card once to reload the filter set with your project's custom statuses.

- **Filters now persist across project switches and reload** (`beads-task-issue-tracker-97o`): `useFilters()` had a force-reset block that ran on every call and overwrote `status` with the workflow defaults (`open + in_progress + deferred + pinned + hooked`) plus cleared `search`/`labels`/`assignee`, ignoring whatever the user had previously stored in `localStorage`. So clearing filters in project A and switching B → A would silently revert A back to the workflow view instead of keeping the empty state. The workflow defaults are now expressed as `defaultFilters` and applied **only on first visit** when no value exists for the project (`useProjectStorage` semantics) — explicit user state survives navigation, project switches, and full reload. The KPI Workflow card already provides a one-click way to restore the defaults, so the implicit auto-reset was redundant. Best-practice alignment: Linear, Tableau, Salesforce, and other workspace-scoped filter UIs preserve last state by default and apply defaults only when nothing is stored. Side-effect fix in `useProjectStorage.loadValue`: `defaultValue` is now deep-cloned before being returned, so mutating `filters.value.status = []` in one project no longer leaks into the shared `defaultFilters` object and contaminates the next project's load. 5 new integration tests cover fresh install (workflow default), reload survival of cleared state, A→B→A round-trip, search/labels/assignee persistence, and `hasActiveFilters` reactivity

### Tests
- **Integration test for `useExclusionFilters` migration** (`beads-task-issue-tracker-jq9`): the existing suite reimplemented `SYSTEM_LABELS`, the v1/v2 flag names, `perProjectMigrationKey`, `upgradeV1FlagIfNeeded`, and `runMigration` as local pure functions — so a change to production migration logic (e.g. adding a new system label) would have left the tests green while the real composable drifted. Rewritten to import `useExclusionFilters` and `useBeadsPath` directly, use `vi.resetModules()` + `await import(...)` per test to re-execute the module-level `watch(beadsPath, ..., { immediate: true })` that actually drives the migration, and install a fresh in-memory `Storage` stub per test (same pattern as the `useStatusColorOverrides` suite). 7 tests cover fresh install, v1→v2 flag upgrade, user-choice-respected, no-duplication, project switch via `setPath`, switch-back after user cleared `gt:slot`, and `activeCount`/`hasActiveExclusions` reactive state. Required adding explicit `import { ref, watch, readonly, computed } from 'vue'` to `app/composables/useBeadsPath.ts` and extending the existing Vue import in `app/composables/useExclusionFilters.ts` with `computed` — both composables previously relied on Nuxt auto-imports that are absent under Vitest
- **Integration test for `useStatusColorOverrides`** (`beads-task-issue-tracker-mmw`): the existing test file reimplemented the style formula and an abstract store instead of importing the real composable, so the claimed `beads:proj:<hash>:status-colors` key format and `useProjectStorage` integration were never verified. Rewritten to import `useStatusColorOverrides` and `clearProjectStorageCache`/`reloadProjectStorage` directly and exercise them against a fresh in-memory `Storage` stub per test (Node 25's built-in `localStorage` broke jsdom's Storage prototype — `.clear` was undefined — so each test now installs a clean memory-backed `Storage` via `Object.defineProperty`). 5 tests cover round-trip, localStorage key format, project-scoped isolation, path-switching via `reloadProjectStorage`, and persistence across reload. Adds a `nuxtMetaPlugin` in `vitest.config.ts` that rewrites `import.meta.client` → `true` and `import.meta.server` → `false` in `/app/` files at Vite transform time (excluding `node_modules`), so real Nuxt-flavoured composables run under Vitest without `import.meta.client` guards silently short-circuiting

### Workflow & Documentation
- **Reference `.claude/references/bd-knowledge.md`** (`beads-task-issue-tracker-ae8`): new lazy-loaded knowledge base on bd internals — sources of truth for statuses (`bd statuses` vs `.beads/issues.jsonl` as anti-pattern), category table with counter-intuitive built-ins (`blocked=wip`, `pinned=frozen`, `hooked=wip`), `status.custom` format in Dolt (not in `config.yaml`), differences between status definitions and usages, edge-cases (`BUILTIN_FALLBACK` guard, `bd statuses` vs `bd status`). The file is not auto-loaded — it is read explicitly via citation from root `CLAUDE.md` at zero token cost until consulted. First batch of insights sourced from the `ud2` investigation.
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
