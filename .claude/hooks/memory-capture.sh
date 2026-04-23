#!/bin/bash
#
# PostToolUse:Bash (async) - Capture knowledge from bd comments add commands
#
# Detects: bd comments add {BEAD_ID} "TYPE: ..."
# Types: LEARNED, DECISION, FACT, PATTERN, INVESTIGATION
# Extracts knowledge entries into .beads/memory/knowledge.jsonl
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only process Bash tool
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

# Extract the command that was executed
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

# Only process bd comments add commands containing knowledge markers
echo "$COMMAND" | grep -qE 'bd\s+comments\s+add\s+' || exit 0
echo "$COMMAND" | grep -qE '(INVESTIGATION:|LEARNED:|DECISION:|FACT:|PATTERN:)' || exit 0

# Extract BEAD_ID (argument after "bd comment")
BEAD_ID=$(echo "$COMMAND" | sed -E 's/.*bd[[:space:]]+comments[[:space:]]+add[[:space:]]+([A-Za-z0-9._-]+)[[:space:]]+.*/\1/')
[[ -z "$BEAD_ID" || "$BEAD_ID" == "$COMMAND" ]] && exit 0

# Extract the comment body (content inside quotes after bead ID)
COMMENT_BODY=$(echo "$COMMAND" | sed -E 's/.*bd[[:space:]]+comments[[:space:]]+add[[:space:]]+[A-Za-z0-9._-]+[[:space:]]+["'\'']//' | sed -E 's/["'\''][[:space:]]*$//' | head -c 4096)
[[ -z "$COMMENT_BODY" ]] && exit 0

# Determine type and extract content (5 knowledge types)
TYPE=""
CONTENT=""
for PREFIX in INVESTIGATION LEARNED DECISION FACT PATTERN; do
  if echo "$COMMENT_BODY" | grep -q "${PREFIX}:"; then
    TYPE="${PREFIX,,}"
    CONTENT=$(echo "$COMMENT_BODY" | sed "s/.*${PREFIX}:[[:space:]]*//" | head -c 2048)
    break
  fi
done

[[ -z "$TYPE" || -z "$CONTENT" ]] && exit 0

# Generate key from content (type + slugified first 60 chars)
SLUG=$(echo "$CONTENT" | head -c 60 | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')
KEY="${TYPE}-${SLUG}"

# Detect source agent from subagent context
# shellcheck source=./lib/subagent-detect.sh
source "$CLAUDE_PROJECT_DIR/.claude/hooks/lib/subagent-detect.sh"
SOURCE="orchestrator"
if is_subagent "$INPUT"; then
  SOURCE="supervisor"
fi

# Build tags array - start with type tag
TAGS_ARRAY=("$TYPE")

# Scan content for known tech keywords and add matching tags
for tag in api security test database \
           networking ui layout performance crash bug fix workaround \
           gotcha pattern convention architecture auth middleware \
           async concurrency model protocol adapter; do
  if echo "$CONTENT" | grep -qi "$tag"; then
    TAGS_ARRAY+=("$tag")
  fi
done

# Convert tags array to JSON
TAGS_JSON=$(printf '%s\n' "${TAGS_ARRAY[@]}" | jq -R . | jq -s .)

# Get timestamp
TS=$(date +%s)

# Build JSON entry with proper escaping
ENTRY=$(jq -cn \
  --arg key "$KEY" \
  --arg type "$TYPE" \
  --arg content "$CONTENT" \
  --arg source "$SOURCE" \
  --argjson tags "$TAGS_JSON" \
  --argjson ts "$TS" \
  --arg bead "$BEAD_ID" \
  '{key: $key, type: $type, content: $content, source: $source, tags: $tags, ts: $ts, bead: $bead}')

# Validate JSON
[[ -z "$ENTRY" ]] && exit 0
echo "$ENTRY" | jq . >/dev/null 2>&1 || exit 0

# Resolve memory directory
MEMORY_DIR="${CLAUDE_PROJECT_DIR:-.}/.beads/memory"
mkdir -p "$MEMORY_DIR"
KNOWLEDGE_FILE="$MEMORY_DIR/knowledge.jsonl"

# Deduplicate: skip if key already exists
if [[ -f "$KNOWLEDGE_FILE" ]] && grep -qF "\"key\":\"$KEY\"" "$KNOWLEDGE_FILE"; then
  exit 0
fi

# Append entry
echo "$ENTRY" >> "$KNOWLEDGE_FILE"

# Rotation: archive oldest 500 when file exceeds 1000 lines
LINE_COUNT=$(wc -l < "$KNOWLEDGE_FILE" 2>/dev/null | tr -d ' ')
if [[ "$LINE_COUNT" -gt 1000 ]]; then
  ARCHIVE_FILE="$MEMORY_DIR/knowledge.archive.jsonl"
  head -500 "$KNOWLEDGE_FILE" >> "$ARCHIVE_FILE"
  tail -n +501 "$KNOWLEDGE_FILE" > "$KNOWLEDGE_FILE.tmp"
  mv "$KNOWLEDGE_FILE.tmp" "$KNOWLEDGE_FILE"
fi

exit 0
