#!/bin/bash
# poll.sh <taskId> — one-shot digest read. No loop. No bd comments.
set -euo pipefail
ID="${1:?taskId}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$ROOT/lib.sh"
if [ -z "${ORCH_NS:-}" ]; then
  orch_resolve_ns || exit 1
else
  NS_DIR="$ORCH_NS"
fi
DIGEST="$NS_DIR/results/${ID}.digest"
RESULT="$NS_DIR/results/${ID}.md"
if [ ! -f "$DIGEST" ] && [ ! -f "$RESULT" ]; then
  echo "✗ нет digest/result для $ID" >&2
  exit 1
fi
if [ -f "$DIGEST" ]; then
  head -n 10 "$DIGEST"
else
  head -n 10 "$RESULT"
fi
