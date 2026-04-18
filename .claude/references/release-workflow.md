# Release Workflow — GitHub Account: Maxpceo

## Releases

1. **Update `CHANGELOG.md`** with the target version heading and all changes.
2. **Run `./release.sh`** — interactive script that:
   - Checks branch (must be main), tests, TypeScript
   - Asks for new version number with confirmation
   - Verifies CHANGELOG has an entry for the version
   - Updates version in `package.json` + `src-tauri/tauri.conf.json`
   - Creates commit, tag, pushes — with confirmation at each step
   - GitHub Actions automatically builds DMG/EXE/AppImage from the tag
3. **Update `.claude/codebase-map.md`** to reflect any structural changes (new files, composables, commands, etc.)

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
