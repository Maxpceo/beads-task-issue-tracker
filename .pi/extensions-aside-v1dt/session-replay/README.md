# Session Replay

Project-local Pi extension that registers `/replay`.

- Opens a read-only overlay for the current session branch timeline.
- Shows user, assistant, tool, custom/workflow, and system/session entries.
- Keys: `↑/↓` or `j/k` navigate, `Enter` expands/collapses, `Home/End/PageUp/PageDown` jump, `Esc` or `Ctrl-C` closes.
- Long content is truncated in previews and wrapped in expanded rows.

The command only reads `ctx.sessionManager.getBranch()` and does not mutate session state.
