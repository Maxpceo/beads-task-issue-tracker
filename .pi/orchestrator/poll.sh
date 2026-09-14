#!/bin/bash
# poll.sh <taskId> — one-shot digest read. No loop. No bd comments.
# Orchestrator on-demand insurance when ping never arrives (dispatch-supervisor path B /
# review-bead reviewer hop). Not the primary channel — primary remains ping.sh →
# complete_visible_dispatch. Never auto-timer / scheduler_create / hang loop.
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
DIGEST="${DIGEST_FILE:-$NS_DIR/results/${ID}.digest}"
RESULT="${RESULT_FILE:-$NS_DIR/results/${ID}.md}"
if [ ! -f "$DIGEST" ] && [ ! -f "$RESULT" ]; then
  echo "✗ нет digest/result для $ID" >&2
  exit 1
fi
if [ -f "$DIGEST" ]; then
  head -n 10 "$DIGEST"
else
  head -n 10 "$RESULT"
fi
