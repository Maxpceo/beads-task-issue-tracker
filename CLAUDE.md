# CLAUDE.md

## Context Documents

- **[.claude/codebase-map.md](.claude/codebase-map.md)** — Architecture, all pages, components, composables, utils, Tauri commands, types, data flow
- **[docs/attachments.md](docs/attachments.md)** — Attachment system (filesystem-only, `external_ref` reserved for real external refs)

Consult these before starting any task.

## Workflows

### Evidence before claims

Completion reports (both orchestrator and supervisor) must not use hedging language: *"should work / probably / seems / looks correct / выглядит корректно / должно работать / наверное работает / вроде проходит"*. Any status claim (tests pass, build ok, bug fixed, acceptance met) requires **fresh evidence in the same message**: command run + actual output + exit code. If the command wasn't run, write the actual state ("tests not run yet"), not a guess. Celebratory phrases ("Готово!", "Perfect!") are allowed ONLY after the evidence, never instead.

Canonical wording and banned-phrase list: `.claude/skills/subagents-discipline/SKILL.md` → Iron Law section.

### Issues
- `/run-issue <id>` — Always run before starting work on any issue
- `/close-issue` — Always ask confirmation before closing
- `/review-to-commit` — Always use when user asks to commit

### Enrich bead with context

For non-trivial beads (> 20 lines OR > 1 file), right after `bd create` add implementation context via `bd update {ID} --notes` or `--design` (or `bd create --notes`/`--design` in one call):

- **Files:** exact paths + line ranges (`src-tauri/src/lib.rs:123-145`)
- **Current state:** what's there now (snippet, behavior, contract)
- **Target state:** what it should become (snippet, expected behavior)
- **Investigation findings:** what you already checked (grep results, linked beads) — so the supervisor doesn't re-investigate
- **Pattern reference:** working analogue elsewhere in the project, if any

Short title = "what and why". Notes/design = the detailed "how and where". Goal: a future session picks up the bead and works WITHOUT repeating the investigation.

**Skip** for trivial fixes (< 20 lines, 1 file) — title alone is enough.

### Labels
When creating issues with `bd create`, **always** add `--label` based on which domain the issue touches. Pick 1-2 most relevant labels.

| Label | When to use | Files / domains |
|-------|-------------|-----------------|
| `frontend` | Vue components, composables, pages | `app/components/`, `app/composables/`, `app/pages/` |
| `backend` | Rust code, Tauri commands | `src-tauri/src/lib.rs`, `src-tauri/src/main.rs` |
| `tracker` | Built-in SQLite engine | `src-tauri/src/tracker/` |
| `ui` | Visual components, shadcn, themes, CSS | `app/components/ui/`, theme, styles |
| `ci` | GitHub Actions, automation | `.github/workflows/` |
| `dx` | Dev tools, tests, configs, docs | `tests/`, `vitest.config.ts`, `CLAUDE.md`, `.claude/` |
| `sync` | Sync, Dolt, git sync, polling, watcher | `useAdaptivePolling`, `useChangeDetection`, `useSyncStatus`, sync Rust code |
| `data` | Filtering, sorting, CRUD, bd-api | `bd-api.ts`, `issue-helpers.ts`, `useIssues`, `useFilters` |

Examples:
- `bd create --title="Fix Dolt badge" --type=bug --priority=3 --label=backend --label=sync`
- `bd create --title="Add column resize" --type=feature --priority=2 --label=frontend --label=ui`
- `bd create --title="Add CI workflow" --type=task --priority=2 --label=ci --label=dx`

### Session Completion
All steps mandatory. Work is NOT complete until `git push` succeeds.
1. File issues for remaining work
2. Run quality gates (if code changed): `pnpm test && npx vue-tsc --noEmit`
3. Close finished issues
4. **Update CHANGELOG.md** — add entries under `[Unreleased]` for all code changes in this session
5. `git pull --rebase && bd sync && git push && git status`

### Before Merge to main
**MANDATORY checklist** — do not merge without completing:
1. All tests pass: `pnpm test && npx vue-tsc --noEmit`
2. `CHANGELOG.md` updated with all changes (under `[Unreleased]` or version heading)
3. `README.md` reflects any user-facing changes (new features, new commands, etc.)
4. All beads closed

### Testing
- **Run before committing**: `pnpm test` — runs all Vitest unit tests
- **Watch mode**: `pnpm test:watch` — for development
- Tests live in `tests/` mirroring `app/` structure (e.g., `tests/utils/markdown.test.ts` → `app/utils/markdown.ts`)
- Pure logic must be extracted into `app/utils/` for testability (not buried in composables)
- When adding or modifying pure logic (filtering, sorting, parsing, transformations), add or update corresponding tests

### Code Organization
- **Never overload `app/pages/index.vue`** — extract logic into composables (`app/composables/`) and UI sections into dedicated components (`app/components/`)
- Keep `index.vue` as an orchestrator: layout structure, composable wiring, and minimal glue code
- Prefer reusable composables over inline logic for state, dialogs, resize, filtering, etc.
- **Prefer shared components** over duplication — if a UI element is used in multiple places, extract it into a shared component

### Context Management
- **Always prefer `/continue-task` over `/compact`** — it preserves issue context, progress, and next steps far better
- When the session is long and context is getting large, proactively run `/continue-task` before auto-compact triggers
- If a `PreCompact` hook fires with "auto" trigger, immediately run `/continue-task` instead of letting compact proceed blindly

### bd Version Policy
- **Stay on bd 0.49.x** — this is the last stable version with embedded Dolt (CGO) and SQLite backend. It was installed via Homebrew (`brew install bd`) and compiled locally with CGO support.
- **Do NOT upgrade to bd 0.50–0.56+** — versions 0.50+ progressively removed embedded Dolt in favor of server mode (`dolt sql-server`). Version 0.56 removed CGO entirely. Server mode is a regression for standalone desktop apps: no file watcher support, requires polling, server lifecycle management, single-project-per-port limitation.
- **Pre-compiled binaries from GitHub releases (0.50+) lack CGO** — even versions that still have embedded Dolt in source code (0.50–0.55) ship without CGO in their release binaries, making embedded mode non-functional.
- **The branch `feat/bd-056-server-mode`** contains all the work to support bd 0.56 (server mode detection, adaptive polling fix, migration logic, DoltServerBanner). It can be merged if/when bd provides a viable path for standalone apps (e.g., change notification mechanism, multi-database server support).
- **GitHub issue [#2050](https://github.com/steveyegge/beads/issues/2050)** tracks our feedback to the bd team about server mode regressions.
- Always preserve backward compatibility with bd 0.49 — use version-gated helpers (`supports_bd_sync()`, `supports_daemon_flag()`, etc.) in the Rust backend to branch behavior by CLI version.

### bd Backward Compatibility
- Never assume all projects use Dolt — check `project_uses_dolt()` before skipping legacy paths
- Use version-gated helpers in `src-tauri/src/lib.rs` for any feature that depends on a specific bd version

### Logging
- **Never use `console.log`** — always use the native logger so logs end up in the app log file.
- **Frontend (TypeScript)**: `logFrontend('info', '[context] message')` — import from `~/utils/bd-api`. Calls the Rust `log_frontend` Tauri command which writes via `log::info!("[frontend] ...")`.
- **Backend (Rust)**: `log_info!("[context] message")`, `log_error!(...)` macros — write directly to the native log.
- Levels: `'info'`, `'warn'`, `'error'`
- **Log file**: `~/Library/Logs/com.beads.manager/beads.log` — readable via `tail -f` or in the app.

### Dev Server
Always kill zombies before starting: `pkill -f "$(pwd)/src-tauri/target/debug/beads-issue-tracker" 2>/dev/null && pnpm tauri:dev`

Note: scope the `pkill` match to the dev binary path. A bare `pkill -f "beads-issue-tracker"` also kills the installed `/Applications/Beads Task-Issue Tracker.app` because both binaries share the same executable name (`beads-issue-tracker` from the Cargo crate).

### Model Selection

Pick the least powerful model that can do the job — saves time and cost. When dispatching via `Agent()`, pass `model="sonnet"` or `model="opus"` explicitly.

| Complexity | Model | Examples |
|---|---|---|
| Simple mechanical (1-2 files, clear spec) | **Sonnet** | Renames, adding a field by existing pattern, cosmetics, docs, template code |
| Integration / judgment (multi-file, pattern matching, debugging) | **Sonnet** default, **Opus** when uncertain | New API endpoint following an existing template, refactoring one composable |
| Architecture, cross-domain review, critical logic | **Opus** | New ADRs, complex Tauri backend changes, sync/Dolt engine, hard production bug diagnosis, code review of critical code |

Agent frontmatter already specifies `model: sonnet` for most agents; the orchestrator (Opus) may implicitly inherit — set `model="sonnet"` explicitly for simple tasks to avoid burning Opus on trivialities.

### Completion Report Vocabulary

Supervisors return one of four statuses (full definitions live in each supervisor file):

- **DONE** — work complete, no doubts. Orchestrator → code review.
- **DONE_WITH_CONCERNS** — complete but with caveats. Orchestrator reads concerns; if about correctness/scope → fix before review; if observations → note and proceed.
- **BLOCKED** — supervisor cannot finish. Orchestrator diagnoses: missing context (add, re-dispatch) / needs more reasoning (re-dispatch with more powerful model) / task too big (split) / plan wrong (escalate to user).
- **NEEDS_CONTEXT** — missing info. Orchestrator supplies and re-dispatches.

**Never** re-dispatch the same model on BLOCKED without changing something. If a supervisor is stuck — something must change.

## GitHub — Account: Maxpceo

### Releases
1. **Update `CHANGELOG.md`** with the target version heading and all changes
2. **Run `./release.sh`** — interactive script that:
   - Checks branch (must be main), tests, TypeScript
   - Asks for new version number with confirmation
   - Verifies CHANGELOG has an entry for the version
   - Updates version in `package.json` + `src-tauri/tauri.conf.json`
   - Creates commit, tag, pushes — with confirmation at each step
   - GitHub Actions automatically builds DMG/EXE/AppImage from the tag
3. **Update `.claude/codebase-map.md`** to reflect any structural changes (new files, composables, commands, etc.)

**Release notes must include:**
- bd compatibility version (e.g., `> Requires **bd 0.49.x** — do not use bd 0.50–0.56+`)
- **Never upload DMG manually** — GitHub Actions handles artifacts
- macOS unsigned certificate notice:
  ```
  xattr -cr /Applications/Beads\ Task-Issue\ Tracker.app
  ```

### Commits
- **Always in English** — open source standard for international contributors
- Conventional Commits format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `release:`
- Keep `Co-Authored-By: Claude Code <noreply@anthropic.com>` for transparency

## Permissions

### Always Allowed (no confirmation needed)
- All `bd` CLI commands
- File operations on `.claude/` and `.beads/`
- `~/.claude/` (global config)

### Always Require Confirmation
- `git commit`, `git push`, `/close-issue`

## Plan Mode

Save plans in `.claude/plans/` (local to project), never `~/.claude/plans/`.

### Save approved plan

If a task went through Plan Mode and got approval — save the approved plan as an artifact before dispatching any supervisor:

- Preferred: `.claude/plans/{bead-id}.md` with the plan body
- Alternative: `bd update {ID} --design "PLAN (approved YYYY-MM-DD): ..."`

Format:
```
PLAN (approved YYYY-MM-DD)
Problem: <1-2 sentences>
Approach: <what we do>
Rejected alternatives: <what we considered and why we declined — protects against drift on re-dispatch>
Files to change: <paths>
Acceptance: <how we will verify>
```

**Why:** the plan survives the session. On `NOT APPROVED` and re-dispatch the supervisor sees the original plan. The reviewer cross-checks it during Phase 1 spec compliance. Rejected alternatives are recorded — nobody can "forget" and do it differently.

**Skip** for small fixes that didn't use Plan Mode.
