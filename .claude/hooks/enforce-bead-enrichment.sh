#!/bin/bash
# PreToolUse hook: enforce-bead-enrichment
# Beads: beads-task-issue-tracker-402 (child #2 эпика a4q — порт из invest_fund_sharks)
#
# Objective: cross-session context preservation. Session A has full context at
# moment of `bd create`; Session B (next day / another worktree) should see
# enriched bead immediately, without re-investigating.
#
# Блокирует:
#   C. Bash matcher — `bd create` без embedded enrichment markers
#      (Files / Current state / Target state в --description / --body-file / --design-file)
#   B. Task matcher — Task(subagent_type=*-supervisor) без enrich + PLAN-comment
#
# Grandfathering: hook активен только для beads/commands с датой >= INSTALL_DATE.
# Skip: --type epic, --ephemeral (wisp), --from-markdown / --from-graph / --file (batch), merge-supervisor.
# Override: SKIP_ENRICH_CHECK=1
#
# Два существующих hook'а на Task matcher проверяют до нас:
#   - enforce-bead-for-supervisor.sh (наличие BEAD_ID)
#   - enforce-sequential-dispatch.sh (status != closed, нет blockers)

INSTALL_DATE="2026-04-20"

# Global kill-switch из env процесса hook'а
[[ "$SKIP_ENRICH_CHECK" == "1" ]] && exit 0

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Inline-префикс SKIP_ENRICH_CHECK=1 в COMMAND: hook запускается отдельным процессом
# до исполнения Bash tool'а, inline ENV-префикс виден только дочернему shell'у команды,
# не hook'у. Для Bash matcher'а парсим вручную.
if [[ "$TOOL" == "Bash" ]]; then
  CMD_PREFIX_CHECK=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  if echo "$CMD_PREFIX_CHECK" | grep -qE '(^|[[:space:];&|(])SKIP_ENRICH_CHECK=1([[:space:]]|$)'; then
    exit 0
  fi
fi

# ============================================================
# BRANCH C — Bash matcher (bd create без embedded enrichment)
# ============================================================
if [[ "$TOOL" == "Bash" ]]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  [[ -z "$CMD" ]] && exit 0

  # Only bd create (not bd q, bd todo, bd batch, bd update, bd close, bd show, bd list)
  echo "$CMD" | grep -qE '(^|[[:space:]]|&&[[:space:]]*|;[[:space:]]*)bd[[:space:]]+create($|[[:space:]])' || exit 0

  # Exempt: --type epic (epics aggregate children)
  echo "$CMD" | grep -qE -- '--type[[:space:]=]+epic' && exit 0

  # Exempt: --ephemeral (wisp, not exported to JSONL)
  echo "$CMD" | grep -qE -- '--ephemeral' && exit 0

  # Exempt: --from-markdown / --from-graph / --file (batch modes)
  echo "$CMD" | grep -qE -- '(--from-markdown|--from-graph|--file[[:space:]=])' && exit 0

  # Check markers — either inline in -d / --description / --design, или в heredoc-expansion
  # (heredoc $(cat <<'EOF'...EOF) уже раскрыт в $CMD т.к. bash видит финальную команду).
  # Также проверяем --body-file / --design-file: если указан файл, читаем его.
  MARKERS=('### Files' '### Current state' '### Target state')
  BODY_FILE=$(echo "$CMD" | grep -oE -- '--body-file[[:space:]=]+[^[:space:]]+' | sed -E 's/--body-file[[:space:]=]+//')
  DESIGN_FILE=$(echo "$CMD" | grep -oE -- '--design-file[[:space:]=]+[^[:space:]]+' | sed -E 's/--design-file[[:space:]=]+//')

  MISSING=""
  for M in "${MARKERS[@]}"; do
    FOUND=0
    echo "$CMD" | grep -qF "$M" && FOUND=1
    if [[ "$FOUND" == "0" ]]; then
      for F in "$BODY_FILE" "$DESIGN_FILE"; do
        [[ -z "$F" || "$F" == "-" || ! -f "$F" ]] && continue
        grep -qF "$M" "$F" && { FOUND=1; break; }
      done
    fi
    [[ "$FOUND" == "0" ]] && MISSING="${MISSING}• ${M}\n"
  done

  [[ -z "$MISSING" ]] && exit 0

  REASON="Bead создаётся без контекста. Отсутствуют markers:\n${MISSING}\nВстрой enrichment прямо в --description через heredoc:\n\nbd create --title \"...\" --description \"\$(cat <<'EOF'\n<summary>\n\n### Files\n- app/components/Example.vue:123-145\n- src-tauri/src/tracker/x.rs:40-80\n\n### Current state\n<что сейчас>\n\n### Target state\n<что должно быть>\n\n### Investigation findings\n<grep/read findings>\nEOF\n)\" --label {domain}\n\nАльтернатива: --body-file path.md (файл с теми же markers).\n\nШаблон: .claude/references/workflow-templates.md §1\nOverride: SKIP_ENRICH_CHECK=1 bd create ..."
  jq -n --arg r "$REASON" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
fi

# ============================================================
# BRANCH B — Task matcher (supervisor dispatch)
# ============================================================
if [[ "$TOOL" == "Task" || "$TOOL" == "Agent" ]]; then
  SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')
  PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

  # Only enforce for supervisors
  [[ ! "$SUBAGENT_TYPE" =~ supervisor ]] && exit 0

  # Merge-supervisor is exempt (conflicts are incidental, not tracked separately)
  [[ "$SUBAGENT_TYPE" == "merge-supervisor" ]] && exit 0

  # Extract BEAD_ID
  BEAD_ID=$(echo "$PROMPT" | grep -oE 'BEAD_ID:[[:space:]]*[A-Za-z0-9._-]+' | head -1 | sed -E 's/BEAD_ID:[[:space:]]*//')
  [[ -z "$BEAD_ID" ]] && exit 0

  # Fetch bead once
  BEAD_JSON=$(bd show "$BEAD_ID" --json 2>/dev/null)
  [[ -z "$BEAD_JSON" ]] && exit 0

  # Grandfathering
  CREATED_AT=$(echo "$BEAD_JSON" | jq -r '.[0].created_at // ""' 2>/dev/null | cut -c1-10)
  [[ -z "$CREATED_AT" ]] && exit 0
  [[ "$CREATED_AT" < "$INSTALL_DATE" ]] && exit 0

  # Skip epics
  ISSUE_TYPE=$(echo "$BEAD_JSON" | jq -r '.[0].issue_type // ""' 2>/dev/null)
  [[ "$ISSUE_TYPE" == "epic" ]] && exit 0

  # Check enrich + PLAN markers (enrichment может быть в description или в comments).
  # G1 fix: bd show --json не возвращает .comments в этой версии bd → fallback на `bd comments`.
  DESCRIPTION=$(echo "$BEAD_JSON" | jq -r '.[0].description // ""' 2>/dev/null)
  COMMENTS=$(bd comments "$BEAD_ID" 2>/dev/null)
  COMBINED="${DESCRIPTION}
${COMMENTS}"

  HAS_ENRICH=0
  echo "$COMBINED" | grep -qE 'Files|Current state|Target state' && HAS_ENRICH=1

  HAS_PLAN=0
  echo "$COMMENTS" | grep -qE 'PLAN[[:space:]]*\(approved' && HAS_PLAN=1

  if [[ "$HAS_ENRICH" == "1" && "$HAS_PLAN" == "1" ]]; then
    exit 0
  fi

  # Build "missing" list for helpful message
  MISSING=""
  [[ "$HAS_ENRICH" == "0" ]] && MISSING="${MISSING}• enrich (Files/Current state/Target state)\n"
  [[ "$HAS_PLAN" == "0" ]] && MISSING="${MISSING}• PLAN-comment (PLAN (approved YYYY-MM-DD): ...)\n"

  REASON="Bead '$BEAD_ID' не готов к supervisor dispatch.\n\nОтсутствует:\n${MISSING}\nДобавь:\n1. Enrich: должен быть в description (heredoc в bd create) или в comment с markers Files/Current state/Target state\n2. PLAN: bd comments add $BEAD_ID \"PLAN (approved $(date +%Y-%m-%d)):\nProblem: ...\nApproach: ...\nRejected alternatives: ...\nFiles to change: ...\nAcceptance: ...\"\n\nШаблоны: .claude/references/workflow-templates.md §§1-2\nOverride: SKIP_ENRICH_CHECK=1"
  jq -n --arg r "$REASON" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
fi

exit 0
