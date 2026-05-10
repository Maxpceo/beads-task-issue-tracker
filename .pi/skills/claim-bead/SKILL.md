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
4. Claim and set this Pi session's active bead:
   ```text
   /workflow-claim <ID>
   ```
   This runs `bd update <ID> --claim` and records session-local workflow state (`bead`, `state=claimed`, current branch, start commit), so each Pi instance can show its own active bead in the footer.
5. If the user requested a worktree, create it with an absolute external path and run setup.
6. Enter planning:
   - strict/default: `/plan`
   - only if explicitly requested “plan and implement”: `/plan-auto`
7. Continue with `plan-bead`.

## Rules

- First non-readonly action is `/workflow-claim <ID>` (or, only if the command is unavailable, `bd update <ID> --claim` followed immediately by `/workflow-update bead=<ID> state=claimed branch=<current-branch> start=<HEAD>`).
- Do not edit files before plan approval/auto gate.
- Fast Path intentionally differs from the older Claude one-file/<20-line shortcut: Pi uses `AGENTS.md` risk-aware limits (low-risk direct work up to 3 code files / 80 added lines, with hard supervisor path for workflow/policy/review/merge, `.pi/agents`, scripts, or cross-domain work unless explicitly justified as tiny docs-only/mechanical work).
- If the bead is missing handoff context or concrete acceptance, enrich it or ask before implementation/dispatch.
- Do not create follow-up beads from memory-only context; use the full self-contained template from `AGENTS.md` and add labels plus `parent-child`/`discovered-from`/blocker deps when known.
- Do not use markdown TODOs; progress is in bd.
