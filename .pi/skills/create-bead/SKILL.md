---
name: create-bead
description: Создание self-contained bd задач без guard false positives. Use when the user asks to create a task/bug/feature/bead/issue, record follow-up work, split scope, or document discovered work in bd.
---

# Create Bead

## Goal

Создать качественную bd задачу, которую будущий агент сможет взять без chat history, и сделать это через безопасные command patterns, чтобы Pi guards не блокировали создание по ошибке.

`bd create`/`bd todo add` — tracker operations. Их можно делать из `main`, если нет активного non-terminal bead/worktree lock conflict и команда не меняет файлы репозитория. Lifecycle actions (`bd update --claim`, status transitions, `bd close`) не входят в этот skill.

## When to use

Use this skill when:

- пользователь просит “создай задачу/bead/issue”, “запиши follow-up”, “заведи баг/эпик”;
- во время работы обнаружена новая самостоятельная проблема;
- scope текущей задачи нужно вынести в отдельный bead;
- нужно создать planning/architecture/research task.

Do **not** use for tiny local reminders under ~5 lines/one file where `bd todo add` is enough and no handoff package is needed.

## Pre-flight

1. Check workflow state:
   ```bash
   bd ready --json | head
   git status --short
   git branch --show-current
   ```
2. If current session has an active non-terminal bead, create follow-ups only if they are directly related to that bead; add `--deps discovered-from:<active-id>`.
3. If acceptance is unclear, ask one concrete question with 2-4 options before creating the bead.
4. Search for duplicates when title/domain is not obviously unique:
   ```bash
   bd list --json | jq -r '.[] | select((.title|test("<keyword>";"i")) or ((.description // "")|test("<keyword>";"i"))) | "\(.id)\t\(.status)\t\(.title)"'
   ```

## Required content

Non-epic agent-created beads must include all sections below. Keep headings exactly in English; write content in Russian, preserving technical identifiers.

```markdown
### Origin
- Почему задача появилась: запрос пользователя, source bead, review finding, observed command.

### Files
- path/to/file.ts
- path/to/other.md

### Current state
- Наблюдаемое текущее поведение/ограничение.

### Target state
- Наблюдаемое целевое поведение.

### Investigation findings
- Уже проверенные факты, команды, evidence, ссылки на source beads.

### Decisions
- Принятый подход и почему.

### Rejected alternatives
- Что рассмотрено и почему отклонено.

### Dependencies / blockers
- discovered-from:<id> / parent-child:<epic-id> / blocks:<id> / нет.

### Acceptance criteria
- Конкретный проверяемый результат.

### Verification / acceptance checks
- Команда/manual check с ожидаемым результатом.

### Out of scope
- Что явно не делаем.
```

Required flags:

- `--label` / `--labels` / `-l`: at least one label (`pi`, `workflow`, `frontend`, `backend`, `dx`, etc.).
- `-t` / `--type`: use supported bd types: `bug`, `feature`, `task`, `epic`, `chore`, `decision`.
- `-p` / `--priority`: `0` critical, `1` high, `2` medium, `3` low, `4` backlog.
- `--deps discovered-from:<id>` when the work was discovered from another bead.

## Safe command patterns

### Preferred: inline heredoc command substitution

Use an inline heredoc inside `--description`. This keeps the required sections visible to Pi guards and does not write temporary files into the repo.

```bash
bd create "Русский title с technical identifiers" \
  -t task \
  -p 2 \
  --label pi \
  --label workflow \
  --deps discovered-from:<id> \
  --description "$(cat <<'EOF'
### Origin
- ...
### Files
- ...
### Current state
- ...
### Target state
- ...
### Investigation findings
- ...
### Decisions
- ...
### Rejected alternatives
- ...
### Dependencies / blockers
- discovered-from:<id> / нет.
### Acceptance criteria
- ...
### Verification / acceptance checks
- ...
### Out of scope
- ...
EOF
)" \
  --json
```

This pattern is safe from `main`: it performs a tracker write only and the heredoc content is inspectable before `bd create` runs.

### Не используйте wrappers для guarded `bd create`

Не создавайте guarded beads через Python/Node/Ruby wrappers или через `--description "$(cat /tmp/...)"`: Pi guard проверяет текст shell-команды до выполнения и не может безопасно увидеть `bd create` argv или required `### ...` sections внутри wrapper/file. Если shell quoting сломался, вернитесь к preferred inline heredoc pattern выше и держите все required sections прямо в команде.

### Tiny reminders: `bd todo add`

Use only when all are true: under ~5 lines, one file, no review/supervisor chain, no durable handoff needed.

```bash
bd todo add "Короткое локальное напоминание"
```

## After create

1. Parse and report the created id:
   ```bash
   bd show <id> --json | jq '.[0] | {id,status,title,labels,priority}'
   ```
2. If the bead should be visible to other sessions/remotes, push Dolt state:
   ```bash
   bd dolt push
   ```
3. Do not claim the new bead unless the user explicitly asks to start it. Claiming uses `workflow_claim`, not raw `bd update --claim`.

## Guard troubleshooting

- `enforceBeadEnrichment`: missing required sections, labels, or concrete acceptance/verification bullets. Add the full template; do not create stub tasks.
- `enforceBeadRussianLocale`: title/description prose is English. Rewrite user-facing bead text in Russian; keep technical identifiers unchanged.
- `blockMainMutation`: command writes repo files or stages/commits from `main`. Move temp files to `/tmp`, or use a task worktree for code changes.
- `blockMutationsInPlanning`: planning mode is read-only. Finish/approve the plan before creating beads, unless the active plan explicitly allows related follow-up creation.
- `blockRawBdClaim`: use `workflow_claim(beadId=...)` instead of `bd update --claim`.
- `fastPathDiscipline`: current checkout has risky code changes. For tracker-only `bd create`, use a clean checkout or the safe direct pattern; for code changes, claim/plan the relevant bead first.

## Reporting

Concise response after creation:

```text
Создал bead `<id>`: <title>.
- Type/priority/labels: task/P2/pi,workflow
- Dependencies: discovered-from:<id> / нет
- Sync: `bd dolt push` exit 0 / not run (reason)
```

If creation is blocked, report the exact guard, command pattern used, and the minimal correction. Do not silently bypass policy.
