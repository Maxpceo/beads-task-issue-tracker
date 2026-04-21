# Release Workflow — GitHub Account: Maxpceo

## Releases

0. **Run skill `/release`** (triggers: «сделай релиз», «пора релизить», «prepare release»). It runs pre-flight checks, curates `### Highlights` in CHANGELOG `[Unreleased]` using a ranking heuristic (bd-compat / net-new visible UX / long-standing fix / first-impression change), and previews the release body via `scripts/release-notes.py`. Skill does NOT run `release.sh` itself — it hands off to you.
1. **Update `CHANGELOG.md`** with the target version heading and all changes (English only — see rule in `CLAUDE.md` §Session Completion). Step 0 handles the Highlights curation; the rest stays manual.
2. **Run `./release.sh`** — interactive script that:
   - Checks branch (must be main), tests, TypeScript
   - Asks for new version number with confirmation
   - Verifies CHANGELOG has an entry for the version
   - Updates version in `package.json` + `src-tauri/tauri.conf.json` + `Cargo.toml`/`Cargo.lock`
   - **Previews auto-generated release notes** via `scripts/release-notes.py` (filters out internal/dev-tooling; see §Release Notes below)
   - Creates commit, tag, pushes — with confirmation at each step
   - GitHub Actions automatically builds DMG/EXE/AppImage from the tag and injects the release body from `scripts/release-notes.py`
3. **Update `.claude/codebase-map.md`** to reflect any structural changes (new files, composables, commands, etc.)

## Release Notes (auto-generated)

`scripts/release-notes.py <version>` parses `CHANGELOG.md` for the given version section and produces a clean user-facing release body:

- Drops entire `### Internal` / `### DX` / `### CI` / `### Docs` / `### Refactoring` / `### Workflow & Documentation` subsections.
- Filters individual bullets mentioning dev-tooling noise: `.claude/`, `CLAUDE.md`, `release.sh`, hooks, skills, agents, supervisors, orchestrator, workflow-templates, rules-architecture, test-only changes, vue-tsc, cargo check, etc.
- Merges duplicate category headings (e.g. two `### Fixed` blocks → one).
- **Highlights — curator-first:** if the version section has a `### Highlights` subsection (manually curated), its bullets are used verbatim and that section is skipped from the `## What's New` block to avoid duplication. Falls back to the first 3 bullets of Added/Fixed when no curated block exists (a stderr note is emitted as a reminder). Toggle off entirely with `--no-highlights`.
- Prints ready-to-paste markdown to stdout.

**Authoring a good Highlights section:** 3–5 bullets, each bolded short title + one-line plain-English value for the user. Cover the most impactful changes regardless of their position in CHANGELOG. Feature compatibility with new upstream versions (e.g. bd 1.0.x), net-new user-facing features, and long-standing fixes are all strong candidates. Dev-only work never belongs here.

`release.sh` previews the script output before tagging (note: local preview omits the footer). `.github/workflows/release.yml` runs the same script on CI for `v*` tags, appends `.github/release-footer.md`, and uploads via `body_path`. For the `latest` tag the script is skipped; CI uses a hardcoded preamble + the same footer. Manual `gh release edit --notes-file ...` is still available to tweak body before publishing.

**Tuning the filter:** when a pattern leaks through or an entry is incorrectly dropped, edit `EXCLUDE_PATTERNS` / `DROP_SECTIONS` in `scripts/release-notes.py`.

## Release notes boilerplate (Requirements / Installation / macOS workaround)

These sections live in a single markdown file — **`.github/release-footer.md`** — which is `cat`'d into `release-notes-body.md` by CI for both `v*` and `latest` paths. Do **NOT** re-inline them into the body or the workflow yaml. To change the bd version requirement, installation table, or macOS unsigned-cert notice, edit `.github/release-footer.md` and merge to `main`; the next tag picks it up automatically. For already-published releases, patch the body via `gh release edit v<VERSION> --notes-file ...`. Never upload DMG manually — GitHub Actions handles artifacts.

## Commits

- **Always in English** — open source standard for international contributors.
- Conventional Commits format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `release:`.
- Keep `Co-Authored-By: Claude Code <noreply@anthropic.com>` for transparency.
