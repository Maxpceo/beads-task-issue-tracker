---
name: finalize-epic
description: Pi-native epic finalization sweep. Use after the last required child is terminal, when a parent epic has EPIC HANDOFF, or when user asks to finalize/close an epic.
---

# Finalize Epic

Run this after the last required `parent-child` child is terminal. This is a documented skill path, not a typed tool.

## Guard

1. Inspect the epic and relationships:
   ```bash
   bd show <EPIC_ID> --json
   bd comments <EPIC_ID> --json
   bd list --parent <EPIC_ID> --json
   bd dep list <EPIC_ID> --direction=up --type parent-child --json
   ```
2. Required children are the beads returned by `bd list --parent <EPIC_ID> --json` / `parent-child` relations.
3. `discovered-from` follow-ups are non-blocking unless explicitly converted to `parent-child` or blocking work.
4. Do not close the epic when any required child is non-terminal, when acceptance has `FAIL|NOT RUN|BLOCKED|SCOPE GAP`, or when a required follow-up is unresolved.

## Machine-parseable markers

Markers are case-sensitive. Use exact uppercase keys at line start. Sort status snapshots by child id.

Pre-terminal last-child marker on the child:

```text
PARENT EPIC SWEEP
PARENT_EPIC: <EPIC_ID>
TERMINAL_CHILD: <CHILD_ID>
TARGET_TERMINAL_STATUS: <closed|blocked|deferred>
REQUIRED_CHILDREN_STATUS: <child-a=status,child-b=status>
NEXT_ACTION: finalize-epic|epic-handoff
```

Pre-terminal marker on the parent when the epic cannot be finalized yet:

```text
EPIC HANDOFF
PARENT_EPIC: <EPIC_ID>
TERMINAL_CHILD: <CHILD_ID>
TARGET_TERMINAL_STATUS: <closed|blocked|deferred>
REASON: <why parent is not closed now>
NEXT_ACTION: <exact next action>
```

Progress marker when required children remain:

```text
EPIC PROGRESS
PARENT_EPIC: <EPIC_ID>
REMAINING_REQUIRED_CHILDREN: <child-a=status,child-b=status>
NEXT_ACTION: <next child or blocker>
```

Post-terminal final matrix on the parent:

```text
EPIC ACCEPTANCE MATRIX
PARENT_EPIC: <EPIC_ID>
- criterion: <epic acceptance or verification bullet>
  evidence: <command/manual check>
  exit code: <0|n/a> / observed: <result>
  result: PASS
```

## Workflow

1. Verify all required children are terminal (`closed`, `blocked`, or explicit `deferred` with recorded reason). If not, write `EPIC PROGRESS` and stop.
2. Classify follow-ups as required blockers or non-blocking `discovered-from` work.
3. Verify epic-level acceptance, including child evidence, follow-up classification, and `.claude/*` exclusion for Pi workflow epics.
4. Write `EPIC ACCEPTANCE MATRIX` mapping every epic acceptance/verification bullet to evidence.
5. Close the epic only when every matrix row is `PASS` or `N/A` and no required blocker remains.
6. If the epic cannot close, write `EPIC HANDOFF` with reason, remaining work, and next action.
