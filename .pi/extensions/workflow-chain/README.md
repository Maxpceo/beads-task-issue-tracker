# workflow-chain extension

Project-local Pi extension for viewing and safely dry-running typed workflow chains.

## Commands

- `/workflow-chain` or `/chain` — list available chains.
- `/workflow-chain dry-run <chainId>` — show steps, guards, typed operation, and mutation policy without changing bd state.
- `/workflow-chain run <chainId>` — execute only safe built-in/read-only demo steps.

Workflow-critical `typedWorkflow` steps are handoff-only in v1. They are shown in dry-run and blocked in run with a handoff message to the typed workflow skill/tool.

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
        { "type": "typedWorkflow", "operation": "dispatch_supervisor", "requiredState": "plan_approved", "handoff": "Use dispatch-supervisor" }
      ]
    }
  ]
}
```

YAML support is intentionally narrow for the same schema: `chains:`, chain list items, scalar properties, `steps:`, and step list items only.
