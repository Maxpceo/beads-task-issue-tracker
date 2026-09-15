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

## Mandatory checklist before `bd create`

Do not run `bd create` until every item is true:

- Title is Russian for Maxim; keep only technical identifiers (`bd-api`, file names, commands, labels) in English.
- Duplicate search is done or intentionally skipped because the title/domain is obviously unique.
- Description is visible to guards via inline heredoc inside `--description`; do not use `$VAR`, `$(cat /tmp/...)`, repo temp files, or Python/Node/Ruby wrappers.
- All required `### ...` sections are present with concrete Russian content.
- `-t` / `--type`, `-p` / `--priority`, and at least one `--label` / `--labels` / `-l` are set.
- `--deps discovered-from:<id>` is set for follow-ups or discovered work when a source bead exists.
- First-write / cold-session rule из секции ниже выполнен: все факты, уже известные в этой сессии и нужные имплементеру (anchors, SHA, lineage, naming, recipe), вписаны в description.

## First write = cold-session handoff

Первый `bd create` write — это финальный пакет для холодной сессии, а не черновик. Вопрос человека «хватит ли контекста?» не должен быть триггером полноты.

Проверка перед `bd create` (тест вопроса): если у будущего имплементера возникнет вопрос, ответ на который **уже есть в твоём текущем контексте**, но отсутствует в description — description неполное. Допиши сейчас.

Когда данные уже известны из investigation в этой сессии, description обязан включать их, а не пересказывать шаблон:

- Files: конкретные пути + символы/функции (например `handleSave ~L88`) + что **не трогать**.
- Investigation findings: выполненные команды, наблюдаемые результаты, SHA/PR, lineage beads.
- Decisions: выбранный подход + ключевые API/patterns с reference-путями.
- Suggested branch/worktree naming, если тип работы уже понятен.

Запрещено: тонкий шаблон, где секции заполнены общими фразами; тактика «обогащу, если спросят»; намеренное скрытие известных anchors, SHA или API names ради краткости.

Антипаттерн: все 11 секций формально присутствуют, labels проставлены, но нет ни одной конкретной привязки (symbol, SHA, команда, reference path) — такой bead не является self-contained, несмотря на пройденную структуру.

Это не требование проводить полное investigation до create: правило касается в первую очередь данных, которые сессия уже знает. Но «не знал, потому что не смотрел» — не освобождение: если в description нет ни одной конкретной привязки (path, symbol, команда, SHA, reference), сначала доберись минимального evidence или спроси пользователя — не создавай stub.

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
- Только gate-executable / gate-mapped команды для `review_bead` ACCEPTANCE MATRIX.
- Допустимо: `pnpm test` / focused `vitest`, `npx vue-tsc --noEmit`, `cargo check`, `git diff --name-only` (no `.claude`/`CLAUDE.md`), `git diff --check`, safe `rg`/`grep` с path under worktree.
- Нельзя класть сюда manual/live/prose/«CODE REVIEW: APPROVED…» — это Acceptance criteria или IMPLEMENTATION comment; иначе раньше был ложный NOT RUN, теперь non-executable → N/A, но verification должна оставаться executable-first.
- Команда с ожидаемым exit 0 / PASS.

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
