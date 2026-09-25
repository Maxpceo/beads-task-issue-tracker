---
name: land
description: Pi-native landing workflow. Use when user says “пора заканчивать”, “push всё”, “сохрани работу”, “landing the plane”.
---

# Land

`land` is an explicit user-triggered save/push checkpoint for the current feature branch. It is not an automatic per-task stage and is not required after a bead reaches `closed`. `merge-to-main` is the later explicit PR → merge → checkout main workflow.

## Workflow

1. Read `.pi/config/workflow-chains.json`. When `handoffFromCopy` is true (tracker default, also when the file is missing/unreadable), ensure the current tool cwd is the active feature/task worktree when `workflowState.worktreePath` is present. `land` must not save/push from `main` under an active worktree lock; use `main` only for read-only inspection until explicit `merge-to-main` completes PR merge and transitions to `main`. When `handoffFromCopy` is false, landing is not a copy ritual: save/push from the recorded checkout even if it is the project tree without a separate task copy.
2. Inspect state, preferably in one compact command:
   ```bash
   git status --short
   git branch --show-current
   bd list --status=in_progress
   bd list --status=inreview
   ```
2. File follow-up beads for remaining work using the full `AGENTS.md` template. Track every follow-up bead created in this session for the final report.
3. Resolve session beads before push:
   - `inreview` with `CODE REVIEW: APPROVED` and acceptance evidence may be closed by the orchestrator;
   - if the user explicitly accepts completed/inreview work with phrases such as “завершай”, “закрывай”, “принято”, “всё ок”, or “accepted”, treat it as human acceptance: record acceptance evidence/comment when needed, run `workflow_update(bead=<ID>, session=accepted)`, close via standard `bd close`, then run `workflow_complete(state=closed, reason=<bead closed>)` or reset to idle;
   - `inreview` without approval or human acceptance remains open and must be listed;
   - `in_progress` remains open unless the work is explicitly accepted/closed by an allowed fast-path route.
   - Do not use `land` to skip bd lifecycle authority: current-session active beads with bd status `inreview` still need `review-bead` or explicit human acceptance, and active non-terminal bd statuses block unrelated next work unless explicitly handed off/deferred with reason.
4. Run quality gates if code changed:
   ```bash
   pnpm test && npx vue-tsc --noEmit
   ```
   For docs/beads-only changes, record `not run: docs/beads only` rather than implying tests passed.
5. Commit code with explicit paths only:
   ```bash
   git add <files>
   git commit -m "<message>"
   ```
6. Commit/sync beads if needed. After a human-accepted bead close, run `bd dolt push` so the close state is not stranded locally:
   ```bash
   bd dolt pull || true
   bd dolt push || true
   ```
   If this project is in legacy JSONL mode, commit `.beads/` explicitly with named paths.
7. Acquire merge-slot and push with a **session-scoped** holder (never bare acquire, never Maxpceo/git `user.name`):

   **Holder recipe (copy-paste; compute once immediately before acquire):**
   1. `sessionKey` = runtime Pi session id of **this** process (`id:…` only). Sources in priority: live `sessionManager` / current process identity; `workflow_status` → `details.sessionKey` when still bound; latest bead comment `PI_SESSION_KEY:` **only if it matches the current runtime id**. Reject `file:`/`leaf:`. After `workflow_complete`/terminal unbind, persisted `workflowState.sessionKey` is intentionally wiped — policy still treats the matching runtime id as own-session evidence; do not claim a foreign bead just to restore persist.
   2. `SESSION_UNIQ` = body after `id:` with **all dashes stripped** (full string, **not** 8-char truncate).
   3. `SUFFIX` = last `-` segment of active bead id, or `none` if no active bead (typical after close/`workflow_complete`).
   4. `HOLDER` = `pi:<SESSION_UNIQ>:<SUFFIX>`.
   5. Golden vector: `id:01a0a712-68e8-7664-b26e-347042f09f14` + `beads-task-issue-tracker-ho0p` → `pi:01a0a71268e87664b26e347042f09f14:ho0p`.
   6. Snapshot the literal holder string, then pass it as a **quoted literal** `--holder 'pi:…'` on every acquire/release (do **not** rely on `$HOLDER` env expansion in the final command).
   7. `land` / push in the **same** Pi session after `bd close` + `workflow_complete` is valid: beads-policy `effectiveMergeSlotSessionKey` = id:-only persist ?? runtime; foreign/stale runtime id and Maxpceo remain deny.

   ```bash
   # Example (replace with this session's literal holder):
   bd merge-slot acquire --holder 'pi:01a0a71268e87664b26e347042f09f14:ho0p'
   git pull --rebase
   git push
   bd merge-slot release --holder 'pi:01a0a71268e87664b26e347042f09f14:ho0p'
   ```
8. If any error happens after acquire, release merge-slot with the **same** literal `--holder` before reporting.
9. Do not require merge evidence for per-task bead close. `land` is only a save/push checkpoint; session-final merge evidence belongs to explicit `merge-to-main`.
10. Verify final pushed state:
   ```bash
   git status -sb
   git log --oneline -3
   ```

## Rules

- Never use `git add .` or `git add -A`.
- Never say “ready to push”; push during this workflow.
- Do not run `land` automatically after every bead; after `closed`, the next bead may be claimed without a push checkpoint unless the user asks to save/push.
- Merge-slot serializes pushes between parallel sessions. Always use session-scoped `--holder pi:<SESSION_UNIQ>:<suffix|none>`; bare acquire and Maxpceo/git user.name holders are blocked by Pi policy. Do not run `git push` if `bd merge-slot acquire` failed. Do not auto-release an in_progress slot held by foreign/Maxpceo holders — stop and report. Own-session push evidence uses runtime id:-only identity when persist was wiped by `workflow_complete`; do not move merge before complete and do not skip policy.
- Do not treat `land` as merge completion. Per-task bead close may happen before merge; session-final merge evidence is recorded by explicit `merge-to-main`.
- Evidence before claims: final report must include commands, exit codes, commits, push evidence, and PR/merge evidence or exception reason.
- If follow-up beads were created during this session, list them even if already closed.

## Reporting

Chat for Maxim follows `AGENTS.md`. Do not emit footer checkpoints for clean status/branch/bd/merge-slot. Stop for failed land, policy/merge-slot blockers, intentionally open session beads, or a Maxim decision: `##` + `## Дальше` with `1/2/3`.

## Final report

`##` + название задачи + (`id`). `## Проверка` — commit/push that actually ran. If follow-ups exist, name them in prose. Then `## Дальше` when Maxim must choose land vs merge vs nothing.
