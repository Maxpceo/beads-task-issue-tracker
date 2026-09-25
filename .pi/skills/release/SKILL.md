---
name: release
description: Pi-native release workflow. Use when user says “сделай релиз”, “пора релизить”, “release”.
---

# Release

Prepare the project for `./release.sh`. The script is interactive and performs irreversible push/tag steps; the human runs it unless the user explicitly asks Pi to drive it and the workflow can safely handle prompts.

## Workflow

1. Pre-flight:
   ```bash
   git status -sb
   git branch --show-current
   git rev-list --count origin/main..HEAD 2>/dev/null
   bd list --status=in_progress
   bd list --status=inreview
   ```
2. Require clean working tree and `main` branch unless user explicitly requests otherwise. If not on `main`, run `merge-to-main` first.
3. Run quality gates if code changed. Read `checks` from `.pi/config/workflow-chains.json`. Reading `checks` does not change `copyRequired`, `reviewRequired`, `matrixRequired`, or `mainWriteAllowed`.
   - No file, unreadable file, broken JSON, missing `checks`, or a `checks` value that is not an array of non-empty strings:
     ```bash
     pnpm test && npx vue-tsc --noEmit
     ```
     Do not add `cargo check` in this fallback.
   - Exact `checks: []`: do not invent `pnpm test`, `vue-tsc`, or `cargo check`.
   - Non-empty array of non-empty strings: run those command strings in order, joined with `&&`. The committed tracker list includes `cargo check --manifest-path src-tauri/Cargo.toml`, so code changes run that check too.
   For docs/beads-only changes, record `not run: docs/beads only` rather than implying tests passed.
4. Review `CHANGELOG.md` `[Unreleased]`. If empty, stop: nothing to release.
5. Curate `### Highlights` under `[Unreleased]` using this ranking:
   1. critical compatibility or upstream adaptation;
   2. net-new visible UX;
   3. long-standing user-visible fix;
   4. first-impression change;
   5. skip internal-only, rename-only, instrumentation-only, or power-user-only entries unless they are release-defining.
6. Write 3-5 English highlight bullets. Format:
   ```markdown
   - **Short title** — one-line user-facing value.
   ```
   Do not include bead IDs or low-level file/function names.
7. Preview release body before handoff:
   ```bash
   { python3 scripts/release-notes.py Unreleased; echo; echo "---"; echo; echo "See the [full CHANGELOG](https://github.com/Maxpceo/beads-task-issue-tracker/blob/main/CHANGELOG.md) for the complete history."; echo; cat .github/release-footer.md; } 2>&1 | head -120
   ```
8. Footer sanity check: `.github/release-footer.md` must mention the current bd requirement and correct installation/artifact guidance. If footer is stale, update the footer source of truth before release.
9. Use the project release script/process:
   ```bash
   ./release.sh
   ```
10. Capture release output, version, commit/tag, and artifact links. Push tags/commits only through merge-slot if the script did not already handle safe push.

    **Merge-slot holder recipe (identical to `land` / `merge-to-main`):** session-scoped `pi:<SESSION_UNIQ>:<suffix|none>` only. `SESSION_UNIQ` = full `id:` body with dashes stripped (not 8-char). Source `sessionKey` from `workflow_status` `details.sessionKey` or `PI_SESSION_KEY` comments (`id:…` only). Golden vector: `id:01a0a712-68e8-7664-b26e-347042f09f14` + `beads-task-issue-tracker-ho0p` → `pi:01a0a71268e87664b26e347042f09f14:ho0p`. Always pass a quoted literal `--holder 'pi:…'` on acquire and release; never bare acquire; never Maxpceo/git `user.name`. Do not auto-release foreign/Maxpceo in_progress holders.

    ```bash
    bd merge-slot acquire --holder 'pi:01a0a71268e87664b26e347042f09f14:ho0p'
    # … push/tag steps …
    bd merge-slot release --holder 'pi:01a0a71268e87664b26e347042f09f14:ho0p'
    ```

## Handoff for human-run release

Final release-prep message should include:

```text
В терминале запусти: ./release.sh
```

Give brief decision guidance:

- tests: `y` if not just run, otherwise `n` is acceptable with evidence;
- version bump: patch for fixes only, minor for user-visible features;
- promote `[Unreleased]`: usually yes;
- preview: inspect Highlights and footer;
- push: answer `y` only when ready to create public release artifacts.

## Rules

- Evidence before claims.
- Do not skip changelog review.
- CHANGELOG / README / release notes are English.
- `main` is read-only for ordinary agent edits/commits. Release-time main mutations are allowed only inside this approved release workflow, with a clean tree, quality gates, and merge-slot-protected push/tag handling using session-scoped `--holder pi:<SESSION_UNIQ>:<suffix|none>` (never bare/Maxpceo).
- If release script asks for human input or fails, stop with exact output.
- Do not invent versioning; use the script and report what it selected/did.

## Final report

Chat for Maxim follows `AGENTS.md`. `##` + что зарелизили. `## Проверка` — quality gates / version / tag that actually ran. Do not replace the human text with the step table.
