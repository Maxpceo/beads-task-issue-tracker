---
name: spawn-task-workspace
description: Open a parallel open bead in a separate cmux workspace via spawn_task_workspace. Use when Maxim says «запусти параллельно», «открой отдельный workspace», «параллельная задача», or when an independent open bead should not share the current Pi session.
---

# Spawn Task Workspace

## Goal

Keep the invariant **one cmux workspace = one Pi session = one bead**, while letting Maxim run a second independent bead in a **new** workspace. Parent session stays on its current bead (or idle) and **never** `workflow_claim`s the target.

## When to use

- Maxim asks to run another bead in parallel / in a separate tab/workspace.
- Target bead is `open`, write-zone is disjoint from the parent's active work, and cmux UI is available.
- Not a substitute for `dispatch_supervisor` / `dispatch_reviewer` (those stay pane-splits **inside** the current workspace).

## When not to use

- Target is the current-session active bead (use normal claim/dispatch).
- Target is `in_progress` / `inreview` / terminal — BLOCKED.
- Plan mode is on (`strict`/`auto`) — turn plan mode off first; spawn is not in `PLAN_MODE_TOOLS`.
- No cmux / headless CI — BLOCKED (Russian reason, not silent headless).
- Write zones overlap or are unclear — ask Maxim; do not guess.
- Want a second supervisor pane for the **same** bead — use `dispatch_supervisor`, not this skill.

## Workflow

1. Confirm target with Maxim if not explicit. Read `bd show <ID> --json`: status must be `open`.
2. Choose `title`: exactly **2–3 words** of essence, no `·` suffix, no full bead id. Example: `Видимый reviewer`, not `Видимый reviewer · 0lp7`.
3. Call the typed tool (do **not** raw `cmux new-workspace`):

   ```text
   spawn_task_workspace({ beadId: "<ID>", title: "<2-3 words>" })
   ```

   Optional: `description`, `color`, `dryRun: true` (argv plan only).

4. Tool responsibilities (do not reimplement in shell):
   - Preflight: cmux identify, target `open`, not own active bead, title 2–3 words, `SPAWN_LOCK` free.
   - `--cwd` = **main checkout** (git-common-dir parent), never the parent task worktree.
   - `--focus false`, `--name "{title} · {suffix}"`, `--command 'pi --approve -- "<Возьми …>"'` (no `pi --name`, no non-ASCII flags).
   - Group flags only when workspace JSON has a group id; else `reorder-workspace --after` caller. One retry without group on group-create fail.
   - `workspace-action set-color` (palette Indigo→Teal→Orange→Purple→Green→Amber, skip parent color); color fail = warning.
   - Resolve child surface; `tab-action rename --surface … --title оркестратор --focus false --workspace <workspaceRef>`. `--workspace` is extra context next to `--surface`, never instead of it. Never rename via `--workspace` alone as the primary path; never rename the **workspace** title to `оркестратор`.
   - Writes `SPAWN_LOCK` on the target; releases on create-fail before Pi starts.

5. Parent after spawn:
   - Do **not** `workflow_claim` the target.
   - Do **not** change parent `workflow-state` to the target bead.
   - Continue the parent's own bead (or stay idle).
   - `land` / merge-slot still serialize push **one session at a time**.

6. Child session (automatic via `--command`):
   - Starts on main checkout with `pi --approve`.
   - Follows `claim-bead`: claim, create canonical worktree, plan, implement.
   - Must leave main before mutating files (already in claim-bead).

## dryRun checks

`spawn_task_workspace({ …, dryRun: true })` should show argv with:

- `--focus false`
- `--cwd` main (not parent hy3z/worktree path)
- `--name` containing ` · {suffix}`
- `pi --approve --` and **no** `pi --name`
- later plan rows for `set-color` and inner `tab-action … --surface` rename to `оркестратор` with `--workspace` beside `--surface` (dryRun placeholder `workspace:NEW`)

## Policy notes

- `beads-policy`: spawn of another open bead allowed while parent non-terminal and plan mode off.
- `workflow_claim` / `dispatch_supervisor` of another bead remain BLOCKED while parent is non-terminal.
- Own bead / busy target / live `SPAWN_LOCK` / missing cmux / bad title → tool BLOCKED with Russian text.

## Out of scope

- Auto-close workspace after `bd close`.
- Parallel merge-slot / simultaneous push.
- Static write-zone analyzer.
- Fixing upstream cmux focus-leak on `tab-action`.
- Custom sidebar / new-window / headless second session.
