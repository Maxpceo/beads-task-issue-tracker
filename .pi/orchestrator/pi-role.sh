#!/bin/bash
# pi-role.sh <role-md-path> <model> <prompt-file> [tools]
# Interactive TUI so Maxim can watch and intervene. Isolation argv is the typed builder's job.
set -euo pipefail
ROLE_MD="${1:?role markdown}"
MODEL="${2:?model}"
PROMPT_FILE="${3:?prompt file}"
TOOLS="${4:-read,bash,edit,write}"

[ -f "$ROLE_MD" ] || { echo "✗ нет файла роли: $ROLE_MD" >&2; exit 1; }
[ -f "$PROMPT_FILE" ] || { echo "✗ нет prompt file: $PROMPT_FILE" >&2; exit 1; }

exec pi --model "$MODEL" --no-session \
  --append-system-prompt "$ROLE_MD" \
  --tools "$TOOLS" \
  "Task: read $PROMPT_FILE and execute it. When you believe the contract is done, write the artifact and digest named in that file, then ping. Do not ping before that."
