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

`release.sh` previews the output before tagging. `.github/workflows/release.yml` runs the same script on CI and injects the output as the release `body_path` — GitHub Actions draft release gets a clean, user-focused body out of the box. Manual `gh release edit` is still available to tweak Highlights before publishing.

**Tuning the filter:** when a pattern leaks through or an entry is incorrectly dropped, edit `EXCLUDE_PATTERNS` / `DROP_SECTIONS` in `scripts/release-notes.py`.

## Release notes must include

- bd compatibility: `> Works with **bd 0.49+** (tested on 0.63.3 and 1.0.x). Self-managing Dolt server on 0.57+.`
- **Never upload DMG manually** — GitHub Actions handles artifacts.
- macOS unsigned certificate notice:
  ```
  xattr -cr /Applications/Beads\ Task-Issue\ Tracker.app
  ```

## Commits

- **Always in English** — open source standard for international contributors.
- Conventional Commits format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `release:`.
- Keep `Co-Authored-By: Claude Code <noreply@anthropic.com>` for transparency.
