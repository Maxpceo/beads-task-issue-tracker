# Pi-native workflow migration plan

## Purpose

Build a Pi-native workflow for this project that preserves the useful parts of the existing Claude Code workflow while making Pi the source of truth for Pi sessions.

`CLAUDE.md` and `.claude/*` are not modified by this migration unless explicitly requested. For Pi, the source of truth is `AGENTS.md` plus `.pi/*`.

## Accepted decisions

| Decision | Result |
|---|---|
| Modify `CLAUDE.md` | No, leave it untouched unless explicitly requested |
| Source of truth for Pi | `AGENTS.md` and `.pi/*` |
| Reuse `.claude/skills` as active skills | No, create Pi-native skills |
| Plan Mode | Use Pi's example `plan-mode` extension as base, then adapt |
| Subagents | Use Pi's example `subagent` extension, but wrap it with typed workflow tools |
| Hooks | Replace Claude hooks with one Pi policy engine |
| Workflow state | Add an explicit state machine |
| Dashboard | Add a status dashboard showing bead, state, branch, worktree, dirty files, merge-slot |
| Review chain | Implement as a typed executable workflow, not just instructions |

## Target structure

```text
.pi/
  settings.json
  plans/
    pi-native-workflow-migration.md
  skills/
    claim-bead/
    plan-bead/
    dispatch-supervisor/
    review-bead/
    land/
    merge-to-main/
    release/
  agents/
    vue-supervisor.md
    tauri-supervisor.md
    test-supervisor.md
    code-reviewer.md
    documentation-expert.md
  extensions/
    plan-mode/
    subagent/
    workflow-state/
    beads-policy/
    beads-dispatch/
    review-workflow/
    status-dashboard.ts
    question.ts
  prompts/
    claim.md
    review.md
    land.md
    merge.md
  presets.json
```

## Implementation phases

| Phase | Deliverable |
|---|---|
| Foundation | `.pi/settings.json`, basic `.pi` layout, `AGENTS.md` Pi workflow section |
| Plan Mode | Project-local `plan-mode` extension with bd allowlist, strict mode, auto mode, plan quality gate |
| Workflow state | Explicit state machine for active bead, branch, worktree, plan mode, merge-slot |
| Policy engine | Centralized policies replacing Claude hooks: git add all block, merge-slot push gate, enrichment, lifecycle, protected paths |
| Typed dispatch | `dispatch_supervisor`, `dispatch_reviewer`, `dispatch_docs_agent` wrappers over Pi subagent execution |
| Pi agents | Pi-native supervisor/reviewer/documentation agent definitions |
| Pi skills | Pi-native skills: claim, plan, dispatch, review, land, merge, release |
| Review workflow | Executable `/review-bead` / `review_bead` chain with guards and acceptance |
| Dashboard | Footer/status display with bead, workflow state, branch, worktree, dirty count, merge-slot |
| Session start | Hidden context injection with current branch, dirty files, in-progress/inreview beads, worktrees |
| Presets/prompts | Optional convenience presets and prompt templates |
| Smoke tests | Verify plan mode, policies, dispatch, review, worktree display, land/merge-slot behavior |

## Claude Code to Pi mapping

| Claude Code workflow | Pi-native replacement |
|---|---|
| `CLAUDE.md` root rules | `AGENTS.md` plus `.pi/*` |
| `.claude/skills` | `.pi/skills` |
| `EnterPlanMode` | `.pi/extensions/plan-mode` |
| Manual plan approval | Strict `/plan` |
| “Plan and implement” | `/plan-auto` plus quality gate |
| `Task(subagent_type=...)` | `dispatch_supervisor` / `dispatch_reviewer` wrapper tools |
| `.claude/agents/*` | `.pi/agents/*` |
| `.claude/settings.json` hooks | `.pi/extensions/beads-policy` |
| `AskUserQuestion` | `question` tool |
| Review skill | `review_bead` executable workflow |
| Session-start hook | Pi session-start context injection |
| Hidden workflow state in rules | Explicit workflow state machine |
| Merge-slot discipline in skills/hooks | Policy-enforced merge-slot push gate |
| Status discovered by manual commands | Pi status dashboard/footer |
| Worktree rules in references/hooks | Workflow state plus policy plus dashboard |
| Claude `land` skill | Pi-native `land` skill |
| Claude `merge-to-main` skill | Pi-native `merge-to-main` skill |

## Plan mode requirements

Strict plan mode requires user approval before execution.

Auto plan mode is allowed only when the user explicitly requests automatic execution after planning. Auto-execute requires the final planning response to include:

```markdown
Plan:
1. ...

Edge-case review:
- ...

Files to change:
- ...

Acceptance:
- ...

Risks / rollback:
- ...

AUTO_EXECUTE_ALLOWED: true
```

If any required section is missing, Pi must remain in plan mode.

## Workflow state responsibility split

| Component | Responsibility |
|---|---|
| `plan-mode` | Tool access, read-only restrictions, strict/auto execution UI |
| `workflow-state` | Bead lifecycle state, active bead, worktree, branch, merge-slot state |
| `beads-policy` | Blocking invalid or unsafe actions |
| `beads-dispatch` | Typed subagent dispatch with correct bead context |
| `review-workflow` | Enforced review chain |
| `status-dashboard` | User-visible state summary; footer prefers session-local `workflow-state.activeBead` and falls back to the newest global `bd in_progress` issue marked with `*` |

## Footer dashboard field sources

`status-dashboard` is a display layer. It must not silently present global or stale values as session-local truth.

| Footer field | Source of truth | Notes |
|---|---|---|
| `wf` / workflow state | Session-local `workflow-state.state` | Owned by lifecycle commands/events such as `/workflow-claim`, `/workflow-update`, `/plan`, `review_bead`, landing/acceptance flows. It is intentionally workflow-owned because bd status alone cannot tell which phase this Pi session is in. |
| `bead` | Session-local `workflow-state.activeBead`; fallback to newest global `bd in_progress` | Explicit workflow bead is shown unmarked and is per Pi session. Global fallback is marked with `*` (for example `bead:abc*`) to show it is not session-local. |
| `plan` | Session-local `workflow-state.planMode` emitted by `plan-mode` | `/plan`, `/plan-auto`, `/plan-cancel`, and approved execution update it. |
| `wt` | Live `git -C <ctx.cwd> worktree list --porcelain`; optional workflow override shown as `wf:<name>` | `primary` means the main checkout; `linked:<name>` means the current Pi process runs in a linked worktree. `wf:<name>` means workflow state explicitly set a worktree override. |
| `dirty` / `clean` | Live `git -C <ctx.cwd> status --short` | `dirty:?` means git status could not be read. |
| `slot` / merge-slot | Session-local `workflow-state.mergeSlotHeld` | Intentionally workflow-owned because the footer tracks whether this Pi session believes it holds the merge slot. Acquire/release workflows must update it; raw `bd merge-slot` commands can desync it. |
| branch | Live `git -C <ctx.cwd> branch --show-current`; workflow branch only as fallback | Prevents stale workflow branch overrides from hiding the actual checkout branch. |
| stats / model / context / token fields | Pi runtime/session APIs | Read from current model, context usage, and assistant usage entries. |
| `ext` | Live extension statuses from `footerData.getExtensionStatuses()` | Excludes duplicate dashboard statuses (`pi-workflow-dashboard`, `workflow-state`). |

## Policies

| Policy | Behavior |
|---|---|
| `blockGitAddAll` | Block `git add .`, `git add -A`, `git add --all` |
| `requireMergeSlotForPush` | Block `git push` unless workflow state says merge-slot is held |
| `protectPaths` | Block edit/write to `.env`, `.git/`, `node_modules/` |
| `blockBdCloseWithoutReview` | Block close unless review/acceptance or explicit fast path permits it |
| `validateReviewChain` | Block invalid lifecycle transitions |
| `enforceBeadEnrichment` | Block `bd create` without `### Files`, `### Current state`, `### Target state`, except allowed exemptions |
| `blockMutationsInPlanning` | During planning, block edit/write and mutating bash |
| `blockSupervisorClose` | Subagents cannot close beads, set orchestrator statuses, or push |
| `blockWorktreeInsideRepo` | Block worktrees created inside the repository |
| `staleWorktreeGuard` | Warn/block when worktree is stale vs main |

Overrides use `PI_SKIP_POLICY=<policy-name>` or `PI_SKIP_POLICY=all` with an explicit reason.

## Smoke test scenarios

| Scenario | Expected result |
|---|---|
| `/plan`, then edit/write | Blocked |
| `/plan`, `bd update` | Blocked |
| `/plan`, `bd show` | Allowed |
| `git add .` | Blocked |
| `git push` without merge-slot | Blocked |
| `bd create` without enrichment | Blocked |
| claim bead | `/workflow-claim <id>` claims in bd and sets session-local workflow state to `claimed`; footer shows explicit workflow bead, or newest global `bd in_progress` fallback marked with `*` |
| auto plan without required sections | Remains in planning |
| auto plan with quality gate | Starts execution |
| dispatch supervisor | Prompt includes bead, branch, start commit |
| supervisor tries `bd close` | Blocked |
| review bead when not `inreview` | Blocked |
| worktree inside repo | Blocked |
| dashboard after worktree creation | Shows worktree path |
| land fails after acquiring merge-slot | Releases merge-slot before reporting |

## Resume instructions

If a session is interrupted:

1. Read this file.
2. Run `bd list --status=in_progress` and `bd ready`.
3. Open the active phase bead.
4. Inspect `.pi/` and `git status --short`.
5. Continue from the next open phase bead.

Progress is tracked in bd, not in this markdown file.
