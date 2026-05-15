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
| Workflow state | Add session-local workflow context fields; bd status remains lifecycle authority |
| Dashboard | Add a status dashboard showing bead, bd status, session mode, branch, worktree, dirty files, merge-slot |
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
| Workflow state | Session-local context for active bead, branch, worktree, plan mode/approval, merge-slot, start commit, optional end commit, and displayed bd status |
| Policy engine | Centralized policies replacing Claude hooks: main/master mutation guard, git add all block, strict worktree layout, stale worktree guard, merge-slot push gate, enrichment, lifecycle, protected paths |
| Typed dispatch | `dispatch_supervisor`, `dispatch_reviewer`, `dispatch_docs_agent` wrappers over Pi subagent execution |
| Pi agents | Pi-native supervisor/reviewer/documentation agent definitions |
| Pi skills | Pi-native skills: claim, plan, dispatch, review, land, merge, release |
| Review workflow | Executable `/review-bead` / `review_bead` chain with guards and acceptance |
| Dashboard | Footer/status display with bead, bd status, session mode, branch, worktree, dirty count, merge-slot |
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
| Hidden workflow state in rules | Explicit bd-first session context |
| Merge-slot discipline in skills/hooks | Policy-enforced merge-slot push gate |
| Status discovered by manual commands | Pi status dashboard/footer |
| Worktree rules in references/hooks | Session context plus policy plus dashboard |
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

## Bd-first lifecycle and session context

bd status is the lifecycle authority for beads. Pi workflow-state is session-local context only: active bead binding, branch/worktree/start/end commit scope, `sessionMode`, plan mode/approval, and merge-slot hint. Common session modes are `claimed`, `planning`, `plan_approved`, `implementing`, `inreview`, `reviewing`, `accepted`, and `closed`, but these values do not replace or coerce bd status.

Terminal bd statuses for per-task blocking are `closed`, `blocked`, or explicit `deferred`/handoff with a recorded reason. bd status `accepted` is not terminal; the bead still needs terminal close. Human phrases such as “завершай”, “закрывай”, “принято”, “всё ок”, or “accepted” for completed/inreview work are treated as human acceptance: the orchestrator records acceptance evidence when needed, runs `/workflow-update bead=<ID> session=accepted`, closes through standard `bd close`, clears/updates session context to `closed`/idle, and syncs bead state with `bd dolt push`. While a current-session active bead has non-terminal bd status, Pi must block claiming, dispatching, or implementing another bead. If bd status is `inreview`, the next valid action is `review-bead` / `review_bead` unless explicit human acceptance is recorded; unrelated work is blocked or redirected with that message. `land` is not part of the mandatory per-task bd-status path: it is an explicit user-triggered save/push checkpoint. `merge-to-main` remains an explicit user-triggered session-final workflow and includes commit/gates/push/PR/merge/main checkout.

Stacked branches must review exact per-task scopes. `review_bead` accepts `startCommit` and `endCommit`; if `endCommit` is absent it uses the latest `END_COMMIT:` comment or `HEAD`. Supervisors/orchestrators should record `/workflow-update end=<sha>` or an `END_COMMIT: <sha>` comment before moving from implementation to review when later commits may be added for other beads.

## Workflow state responsibility split

| Component | Responsibility |
|---|---|
| `plan-mode` | Tool access, read-only restrictions, strict/auto execution UI |
| `workflow-state` | Session-local active bead, `sessionMode`, plan mode/approval, worktree, branch, merge-slot hint, start/end commit scope; reads bd status for display/recovery without treating Pi state as lifecycle authority |
| `beads-policy` | Blocking invalid or unsafe actions, including unrelated next-work transitions while the current-session active bead has non-terminal bd status |
| `beads-dispatch` | Typed subagent dispatch with correct bead context |
| `review-workflow` | Enforced review chain with exact `startCommit..endCommit` scope support |
| `status-dashboard` | User-visible session/bd summary; footer prefers session-local `workflow-state.activeBead` and falls back to the newest global non-terminal bd issue marked with `*` |

## Footer dashboard field sources

`status-dashboard` is a display layer. It must not silently present global or stale values as session-local truth.

| Footer field | Source of truth | Notes |
|---|---|---|
| `session` | Session-local `workflow-state.sessionMode` with legacy fallback to `workflow-state.state` | Describes the current Pi session phase (planning/implementing/reviewing/etc.) and is not lifecycle authority. bd status is displayed separately and controls bead lifecycle gates. |
| `bead` | Session-local `workflow-state.activeBead`; fallback to newest global non-terminal bd issue | Footer display compacts full bd ids to the suffix after the last hyphen (for example `beads-task-issue-tracker-tf9p` renders as `bead:tf9p`). Explicit workflow bead is shown unmarked and is per Pi session. Global fallback is marked with `*` (for example `bead:nxnx*`) to show it is not session-local. Internal workflow/bd state keeps the full id. |
| `plan` | Session-local `workflow-state.planMode` emitted by `plan-mode` | `/plan`, `/plan-auto`, `/plan-cancel`, and approved execution update it. |
| `wt` | Live `git -C <ctx.cwd> worktree list --porcelain` | The custom footer omits `wt` in the primary/root checkout. When the current Pi process runs in a linked worktree, it shows `wt:<basename>` for the current linked worktree; absence of `wt` means no linked worktree is active. Workflow-state `worktreePath` is not displayed as a `wt` override because it can point at the primary/root checkout and would make `wt` misleading. |
| `dirty` / `clean` | Live `git -C <ctx.cwd> status --short` | `dirty:?` means git status could not be read. |
| `slot` / merge-slot | Session-local `workflow-state.mergeSlotHeld` | Intentionally workflow-owned because the footer tracks whether this Pi session believes it holds the merge slot. Acquire/release workflows must update it; raw `bd merge-slot` commands can desync it. |
| `in` / `out` / `cache` | Pi assistant usage entries | Custom footer keeps token/cache totals because the standard Pi footer does not show this breakdown. |
| `ext` | Live extension statuses from `footerData.getExtensionStatuses()` | Excludes duplicate dashboard statuses (`pi-workflow-dashboard`, `workflow-state`). |

Standard Pi/theme footer owns path/branch, selected model, thinking level, context usage, and session cost display. `status-dashboard` must not duplicate those fields in the custom footer.

## Policies

| Policy | Behavior |
|---|---|
| `blockGitAddAll` | Block `git add .`, `git add -A`, `git add --all` |
| `blockMainMutation` | Block edit/write and ordinary `git add`/`git stage`/`git commit` on `main`/`master`, including `.pi/*`; use a feature branch/worktree unless an approved merge/release workflow or explicit override applies |
| `requireMergeSlotForPush` | Block `git push` unless session context says merge-slot is held or current bd merge-slot holder evidence exists |
| `protectPaths` | Block edit/write to `.env`, `.git/`, `node_modules/` |
| `blockBdCloseWithoutReview` | Block standard close and direct terminal status updates unless review/acceptance or explicit fast path permits it |
| `blockEpicCloseWithIncompleteChildren` | Block standard and direct epic completion while any child bead is not closed, unless explicitly overridden with reason |
| `blockUnmergedBranchCompletion` | Deprecated for per-task bead close: multi-task sessions may close accepted beads before explicit `merge-to-main`; merge/origin-main evidence is enforced by session-final `merge-to-main` verdict, not every bead close |
| `validateReviewChain` | Block invalid lifecycle transitions |
| `enforceBeadEnrichment` | Block agent-created non-epic beads without the full self-contained handoff template, labels, and concrete acceptance/verification bullets, except allowed exemptions |
| `blockMutationsInPlanning` | During planning, block edit/write and mutating bash |
| `blockSupervisorClose` | Subagents cannot close beads, set orchestrator statuses, or push |
| `blockWorktreeInsideRepo` | Block new worktrees outside `~/Projects/worktrees/beads-task-issue-tracker/<name>`, including repo-local paths, `.claude/worktrees`, `..`, and symlink escapes |
| `staleWorktreeGuard` | Block commit-like operations when staged code intersects newer `origin/main`; if `origin/main` is unavailable, hard-block code changes and allow docs/beads-only maintenance |
| `fastPathDiscipline` | Warn when direct code work exceeds 3 files or 80 added lines without rationale; hard-block risky scopes or large commit-like work without active bead/approved plan |
| `enforceActiveBeadLifecycle` | Block claiming, dispatching, reviewing, or implementing a different bead while the current-session active bead has non-terminal bd status; bd `inreview` redirects to `review-bead` / `review_bead` |
| `enforceActiveWorktreeCwd` | When current-session active bead has a non-terminal `worktreePath`, block mutating bash, tests/gates, bd writes, edit/write, and typed dispatch/review/docs tools unless they run from/target that worktree (or a subdirectory). This guard runs before `blockMainMutation`; read-only inspection from `main` remains allowed. Missing worktree path or branch mismatch blocks with reset/recreate/takeover guidance. |

Overrides use `PI_SKIP_POLICY=<policy-name>` or `PI_SKIP_POLICY=all` with an explicit reason.

## Smoke test scenarios

| Scenario | Expected result |
|---|---|
| `/plan`, then edit/write | Blocked |
| `/plan`, `bd update` | Blocked |
| `/plan`, `bd show` | Allowed |
| edit/write project file on `main` | Blocked |
| edit/write `.pi/*` on `main` | Blocked |
| edit/write in feature worktree | Allowed |
| active bead has task worktree lock, mutating command from `main` | Blocked by `enforceActiveWorktreeCwd` before `blockMainMutation` |
| active bead has task worktree lock, `bd show` / `bd comments` / `git status` from `main` | Allowed as read-only inspection |
| active bead has task worktree lock, edit/write outside worktree | Blocked by `enforceActiveWorktreeCwd` |
| active bead has task worktree lock, cwd is worktree subdirectory or symlink to it | Allowed |
| active bead has task worktree lock, missing path or branch mismatch | Blocked by `enforceActiveWorktreeCwd` with reset/recreate/takeover guidance |
| dispatch/review/docs tool under worktree lock without matching cwd/worktreePath | Blocked by `enforceActiveWorktreeCwd` |
| `git add .` | Blocked |
| ordinary `git add <file>` / `git stage <file>` / `git commit` on `main` | Blocked |
| `git push` without merge-slot | Blocked |
| issue creation without full handoff template | Blocked |
| issue creation with vague-only acceptance | Blocked with ask-user guidance |
| issue creation with full template, labels, and concrete checks | Allowed |
| `bd create` without enrichment | Blocked |
| 1-3 low-risk code files with active Fast Path rationale | Allowed |
| >3 code files or >80 added lines without supervisor path | Warning requiring rationale |
| workflow/policy/review/merge code without bead/approved plan | Blocked |
| docs/beads-only maintenance | Allowed by Fast Path discipline |
| claim bead | `/workflow-claim <id>` claims in bd and sets session-local `activeBead`/`sessionMode=claimed`; footer shows explicit session bead, or newest global non-terminal bd fallback marked with `*` |
| auto plan without required sections | Remains in planning |
| auto plan with quality gate | Starts execution |
| dispatch supervisor | Prompt includes bead, branch, start commit |
| supervisor tries `bd close` | Blocked |
| direct/standard epic completion with incomplete children | Blocked |
| epic completion with all children closed and normal acceptance evidence | Allowed |
| direct status update to non-terminal `inreview` | Allowed by terminal close guard; review-chain policy may still validate orchestrator-only checkpoints |
| direct status update to terminal `closed` while session context is idle and no bd/review evidence exists | Blocked; direct terminal updates cannot bypass accepted/reviewed close evidence |
| accepted bead close on unmerged feature branch | Allowed; per-task bd lifecycle ends at `closed`, and session-final merge evidence is checked by explicit `merge-to-main` |
| merge-to-main requested before origin/main ancestry | Runs explicit PR/merge workflow and final verdict checks; no preceding `land` required |
| current-session active bead has non-terminal bd status, then claim another bead | Blocked by `enforceActiveBeadLifecycle` |
| current-session active bead has bd status `inreview`, then claim/dispatch another bead | Blocked with next action pointing to `review-bead` / `review_bead` |
| current-session active bead has terminal bd status `closed`, then claim next bead | Allowed without requiring `land` |
| review bead when not `inreview` | Blocked |
| worktree inside repo | Blocked |
| worktree under `.claude/worktrees` or path containing `..` | Blocked |
| worktree under `~/Projects/worktrees/beads-task-issue-tracker/<name>` | Allowed |
| stale worktree commit with overlapping staged code | Blocked |
| dashboard after worktree creation | Shows worktree path |
| `review_bead(beadId, startCommit, endCommit)` on stacked branch | Reviews only `startCommit..endCommit`, excluding later unrelated commits |
| merge-to-main requested | Runs explicit commit/gates/push/PR/merge/main checkout workflow; no preceding `land` required |
| land fails after acquiring merge-slot | Releases merge-slot before reporting |

## Resume instructions

If a session is interrupted:

1. Read this file.
2. Run `bd list --status=in_progress` and `bd ready`.
3. Open the active phase bead.
4. Inspect `.pi/` and `git status --short`.
5. Continue from the next open phase bead.

Progress is tracked in bd, not in this markdown file.
