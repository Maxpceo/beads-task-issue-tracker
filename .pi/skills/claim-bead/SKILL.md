---
name: claim-bead
description: Pi-native claim-first workflow. Use when the user says “возьми <ID>”, “делай <ID>”, “claim <ID>”, “начни задачу”, or asks to start a bead.
---

# Claim Bead

## Goal

Claim first, then plan. Do not investigate deeply before claiming.

## Workflow

1. Read-only guard:
   ```bash
   bd show <ID> --json
   ```
2. If closed, stop and propose a follow-up bead.
3. If assigned to someone else, ask before stealing.
4. Claim:
   ```bash
   bd update <ID> --claim
   ```
5. Update Pi workflow state:
   ```text
   /workflow-update bead=<ID> state=claimed branch=<current-branch> start=<HEAD>
   ```
6. If the user requested a worktree, create it with an absolute external path and run setup.
7. Enter planning:
   - strict/default: `/plan`
   - only if explicitly requested “plan and implement”: `/plan-auto`
8. Continue with `plan-bead`.

## Rules

- First non-readonly action is `bd update <ID> --claim`.
- Do not edit files before plan approval/auto gate.
- If the bead is missing handoff context or concrete acceptance, enrich it or ask before implementation/dispatch.
- Do not create follow-up beads from memory-only context; use the full self-contained template from `AGENTS.md` and add labels plus `parent-child`/`discovered-from`/blocker deps when known.
- Do not use markdown TODOs; progress is in bd.
