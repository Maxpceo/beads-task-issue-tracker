# workflow-chain extension

Project-local Pi extension for viewing and safely dry-running typed workflow chains with a dashboard-style TUI widget.

## Commands

- `/workflow-chain` or `/chain` — list available chains in a dark terminal-style dashboard.
- `/workflow-chain dry-run <chainId>` — show horizontal bordered step cards with guards, typed operation, mutation policy, handoff text, and pending/blocked state without changing bd state.
- `/workflow-chain run <chainId>` — execute only safe built-in/read-only demo steps and update cards through pending → running → done/error with elapsed time and truncated output preview.

Workflow-critical `typedWorkflow` steps are handoff-only in v1. They are shown in dry-run and blocked in run with a handoff message to the typed workflow skill/tool. The runner does not spawn agents and does not execute typed workflow tools directly.

## Dashboard display

The widget is designed to resemble the original chain dashboard visual target:

- terminal-style header with chain title, current session mode, bd status, branch, bead, and source config;
- running status line with colored status icons/dots;
- horizontal bordered step cards connected by arrows;
- per-step status (`pending`, `running`, `done`, `error`, `blocked`), elapsed time, guard, operation, mutation policy, and preview;
- safe truncation for long output so the TUI does not overflow;
- usage and handoff guidance for users.

Malformed or missing config is rendered as a friendly dashboard error/empty state instead of crashing. Missing project config falls back to built-in safe demo chains.

## Config precedence

Only the first existing project-local config is loaded:

1. `.pi/workflow-chains.json`
2. `.pi/workflow-chains.yaml`
3. `.pi/agents/workflow-chains.json`
4. `.pi/agents/workflow-chains.yaml`

The extension does not scan `.claude`, `.gemini`, or `.codex`.

## Schema

```json
{
  "chains": [
    {
      "id": "example",
      "title": "Example",
      "description": "Optional description",
      "steps": [
        { "type": "message", "message": "Hello" },
        { "type": "wait", "ms": 100 },
        { "type": "readOnlyBuiltin", "operation": "workflowStatus" },
        { "type": "typedWorkflow", "operation": "dispatch_supervisor", "requiredBdStatus": "in_progress", "requiredSessionMode": "implementing", "handoff": "Use dispatch-supervisor" }
      ]
    }
  ]
}
```

YAML support is intentionally narrow for the same schema: `chains:`, chain list items, scalar properties, `steps:`, and step list items only.
