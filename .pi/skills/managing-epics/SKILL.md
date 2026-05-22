---
name: managing-epics
description: Pi-native epic workflow for cross-domain or multi-supervisor work. Use when user says “создай эпик”, “большая фича”, “cross-domain”, “multi-supervisor”, or when work needs multiple domains/children.
---

# Managing Epics

Use this workflow when one standalone bead is not enough. Progress is tracked in bd; do not create markdown task lists.

## When to use an epic

| Signal | Decision |
|---|---|
| One tech domain and clear scope | Standalone bead |
| Multiple supervisors/domains | Epic |
| Tauri/Rust + Vue/UI + tests | Epic |
| Infrastructure plus code change | Epic |
| Work naturally splits into ordered phases | Epic |
| Cross-domain change under ~50 lines with a clear contract | Standalone bead is acceptable |

An epic is an organizational group. Prefer one feature branch for the whole epic, with children dispatched sequentially unless children touch completely disjoint files.

## Workflow

1. Create or inspect the epic:
   ```bash
   bd create "Реализовать крупную функцию" -t epic --label <domain> --description "Краткий русский контекст эпика и ожидаемый результат"
   bd show <EPIC_ID> --json
   ```
   Epic descriptions should still be self-contained when practical, but child beads carry the implementation handoff detail.
2. For cross-domain/multilayer epics, create a design doc before children or explicitly document why it is unnecessary:
   - preferred output path: `.designs/<EPIC_ID>.md`;
   - include Tauri command signatures, Rust/TypeScript shared shape, Vue component/composable contracts, data flow, and acceptance strategy;
   - use a Pi architect/design-doc agent when available; otherwise the orchestrator drafts the design in plan mode and asks for approval before child creation.
3. Create child beads with full `AGENTS.md` handoff sections, labels, and dependencies:
   ```bash
   bd create "Реализовать backend-часть" -t task --label backend --deps parent-child:<EPIC_ID> --description "$(cat <<'EOF'
   ### Origin
   - Дочерняя задача <EPIC_ID>: зачем нужна эта часть эпика.
   ### Files
   - src-tauri/src/...
   ### Current state
   - Наблюдаемое текущее поведение.
   ### Target state
   - Наблюдаемое целевое поведение.
   ### Investigation findings
   - Уже собранные факты и ссылки на проверенные файлы/команды.
   ### Decisions
   - Выбранный подход и причина выбора.
   ### Rejected alternatives
   - Рассмотренная альтернатива и причина отказа.
   ### Dependencies / blockers
   - parent-child:<EPIC_ID>; blocks/dependencies при необходимости.
   ### Acceptance criteria
   - Конкретные наблюдаемые проверки для приёмки.
   ### Verification / acceptance checks
   - Команды или ручные проверки с ожидаемыми результатами.
   ### Out of scope
   - Явные не-цели задачи.
   EOF
   )"
   ```
4. Add dependency ordering between children when required:
   ```bash
   bd dep add <CHILD_B> <CHILD_A> --type blocks
   ```
   Use `bd ready` to find the next unblocked child.
5. Claim the epic once when work starts, then claim each child before dispatch:
   ```bash
   bd update <EPIC_ID> --claim --json
   bd update <CHILD_ID> --claim --json
   ```
6. Plan and dispatch each child sequentially through the normal Pi chain:
   - `claim-bead` / `plan-bead` for the child;
   - `dispatch_supervisor(beadId=<CHILD_ID>)` after approved plan;
   - `review-bead` after the child reaches `inreview`;
   - run `bd ready` again before the next child.
7. Parallel child dispatch is allowed only when all of these are true:
   - children have no blocker relationship;
   - planned file sets are disjoint;
   - branch/worktree ownership is explicit;
   - merge-slot/push sequencing remains serialized.
8. Close the epic only after all child beads are closed or an explicit documented override is approved:
   ```bash
   bd list --parent <EPIC_ID> --json
   bd close <EPIC_ID> --reason "Все дочерние задачи закрыты и приняты"
   ```
   `beads-policy` blocks standard and direct epic close while child beads are incomplete.


## Epic finalization contract

- Children must be durable `parent-child:<EPIC_ID>` bd relationships, not only text mentions in descriptions.
- Required children are the beads returned by `bd list --parent <EPIC_ID> --json`; `discovered-from` follow-ups are non-blocking unless explicitly converted to required/blocking work.
- After each child review/close/merge, run a parent epic sweep.
- Before terminalizing the last required child, write machine-parseable `PARENT EPIC SWEEP` on the child and `EPIC HANDOFF` on the parent when finalization cannot happen in the same workflow.
- After the last required child is terminal, run `finalize-epic`: write `EPIC ACCEPTANCE MATRIX` on the parent and close only on PASS, or keep a fresh `EPIC HANDOFF` with reason and next action.
- Use `EPIC PROGRESS` only when required children remain. Do not leave a parent epic silently non-terminal when all required children are terminal.

## Rules

- Do not dispatch an epic child without a parent/EPIC_ID context, labels, concrete acceptance, verification checks, and approved plan.
- Do not silently skip the design-doc step for cross-domain work; either produce the design or record why the contract is already clear.
- Children inherit context from the epic but must still be self-contained handoff packages.
- Use `discovered-from:<EPIC_ID>` for follow-ups that are not required children of the epic.
- No `.claude/*` files are modified for Pi epic workflow changes.

## Final report

Use the standard two-column workflow report and include:

| Шаг | Результат |
|---|---|
| Epic | `<EPIC_ID>` status |
| Design doc | path / skipped with reason |
| Children | IDs with dependency order |
| Dispatched | child ID / supervisor / status |
| Blockers | unresolved blockers or — |
| Next ready | output summary from `bd ready` |
