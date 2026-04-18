# Orchestration Reference — Model Selection & Completion Reports

## Model Selection

Pick the least powerful model that can do the job — saves time and cost. When dispatching via `Agent()`, pass `model="sonnet"` or `model="opus"` explicitly.

| Complexity | Model | Examples |
|---|---|---|
| Simple mechanical (1-2 files, clear spec) | **Sonnet** | Renames, adding a field by existing pattern, cosmetics, docs, template code |
| Integration / judgment (multi-file, pattern matching, debugging) | **Sonnet** default, **Opus** when uncertain | New API endpoint following an existing template, refactoring one composable |
| Architecture, cross-domain review, critical logic | **Opus** | New ADRs, complex Tauri backend changes, sync/Dolt engine, hard production bug diagnosis, code review of critical code |

Agent frontmatter already specifies `model: sonnet` for most agents; the orchestrator (Opus) may implicitly inherit — set `model="sonnet"` explicitly for simple tasks to avoid burning Opus on trivialities.

## Completion Report Vocabulary

Supervisors return one of four statuses (full definitions live in each supervisor file):

- **DONE** — work complete, no doubts. Orchestrator → code review.
- **DONE_WITH_CONCERNS** — complete but with caveats. Orchestrator reads concerns; if about correctness/scope → fix before review; if observations → note and proceed.
- **BLOCKED** — supervisor cannot finish. Orchestrator diagnoses: missing context (add, re-dispatch) / needs more reasoning (re-dispatch with more powerful model) / task too big (split) / plan wrong (escalate to user).
- **NEEDS_CONTEXT** — missing info. Orchestrator supplies and re-dispatches.

**Never** re-dispatch the same model on BLOCKED without changing something. If a supervisor is stuck — something must change.
