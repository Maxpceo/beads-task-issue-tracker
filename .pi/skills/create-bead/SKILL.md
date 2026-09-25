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

- Bead title/description language follows `.pi/config/workflow-chains.json` `requireRussian` (see Language below). This skill does not require Russian for every project.
- Duplicate search is done or intentionally skipped because the title/domain is obviously unique.
- Description is visible to guards via Preferred: file-based transport (`write` description to `/tmp/...md`, then `--description "$(cat /absolute/path)"`) or legacy inline heredoc; do not use `$VAR`, unsafe/multi-command `$(cat ...)`, repo-path files, or Python/Node/Ruby wrappers.
- All required `### ...` sections are present with concrete content in the language `requireRussian` requires.
- `-t` / `--type`, `-p` / `--priority`, and at least one `--label` / `--labels` / `-l` are set.
- `--deps discovered-from:<id>` is set for follow-ups or discovered work when a source bead exists.
- First-write / cold-session rule из секции ниже выполнен: все факты, уже известные в этой сессии и нужные имплементеру (anchors, SHA, lineage, naming, recipe), вписаны в description.

## Language

Read `.pi/config/workflow-chains.json` from the project (walk from cwd up to the git root; do not read `.pi/workflow-chains.json`). `requireRussian` controls user-facing title and description prose. It does not change `checks`, `copyRequired`, `reviewRequired`, `matrixRequired`, or `mainWriteAllowed`, and exact `false` does not turn off enrichment.

- Exact boolean `false`: English title and description are allowed. Do not rewrite them into Russian to satisfy `enforceBeadRussianLocale`.
- Missing file, missing field, non-boolean (`"false"`, `0`, `null`), or broken JSON: Russian stays required. Write title and description prose in Russian for Maxim; keep technical identifiers (`bd-api`, file names, commands, labels, API names) unchanged.
- Do not treat a missing file as permission to write English beads.
- Required `###` headings stay English either way. English identifiers inside Russian prose stay allowed when Russian is required.
- `bd comments` that quote an English `bd create` example are not a create. Do not treat them as a locale violation.

This tracker commits `"requireRussian": true`. Another project may set exact `false`.

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

Non-epic agent-created beads must include all sections below. Keep headings exactly in English. Write section content in the language required by `requireRussian` (Russian unless that field is the exact boolean `false`), preserving technical identifiers.

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
- Допустимо: `pnpm test` / focused `vitest`, `npx vue-tsc --noEmit`, `cargo check`, `git diff --name-only`, `git diff --check`, safe `rg`/`grep` с path under worktree.
- Не добавляй verification bullets про legacy reference trees или path exclusion checks, которые не являются gate-executable acceptance.
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

### Preferred: file-based description

Write the full description with the write tool to an absolute path outside the git worktree (обычно `/tmp/...md`), then pass a tight cat form. Guard reads the file bytes and validates sections/locale; `#` and backticks inside the file are safe because shell does not parse the body.

```bash
# 1) write tool → /tmp/bead-desc-<slug>.md  (full ### template; prose language follows requireRussian)
# 2) short bd create:
bd create "Русский title с technical identifiers" \
  -t task \
  -p 2 \
  --label pi \
  --label workflow \
  --deps discovered-from:<id> \
  --description "$(cat /tmp/bead-desc-<slug>.md)" \
  --json
```

Rules for the tight cat form:

- only `--description "$(cat /absolute/path)"` (optional quotes around the path);
- no pipes, semicolons, extra commands, command substitution, or backticks inside `$(...)`;
- absolute path only; file must exist, be readable, and realpath must stay outside the current git worktree;
- do **not** use `bd create --file` / `--body-file` for this — create exemptions skip enrichment checks.

This pattern is safe from `main`: tracker write only; temp file lives outside the repo.

### Legacy: inline heredoc command substitution

Heredoc remains allowed for backward compatibility, but is fragile: bash treats `#` as a comment and backticks as nested substitution **before** bd/guard run. Prefer file-based when the body may contain `#`, backticks, or complex punctuation.

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

### Не используйте wrappers / hidden forms для guarded `bd create`

Не создавайте guarded beads через Python/Node/Ruby wrappers, `$VAR`, backticks-обёртки или небезопасный `$(cat ...)` с pipes/extra commands/relative/repo paths: Pi guard либо не видит content, либо блокирует unsafe transport. Preferred: file-based выше; legacy: inline heredoc без `#`/backticks в теле.

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
- `enforceBeadRussianLocale`: title/description prose is English while `requireRussian` is not the exact boolean `false`. Rewrite user-facing bead text in Russian; keep technical identifiers unchanged. Exact `false` does not trigger this guard and does not turn off enrichment.
- `blockMainMutation`: command writes repo files or stages/commits from `main`. Skip only when `.pi/config/workflow-chains.json` has exact `copyRequired === false` and `mainWriteAllowed === true`. Otherwise move temp files to `/tmp`, or use a task worktree for code changes.
- `blockMutationsInPlanning`: planning mode is read-only. Finish/approve the plan before creating beads, unless the active plan explicitly allows related follow-up creation.
- `blockRawBdClaim`: use `workflow_claim(beadId=...)` instead of `bd update --claim`.
- `fastPathDiscipline`: current checkout has risky code changes. For tracker-only `bd create`, use a clean checkout or the safe direct pattern; for code changes, claim/plan the relevant bead first.

## Reporting

Chat for Maxim follows `AGENTS.md` (markdown `##`, decrypt task terms, no footer dump). After create do not end on id/labels/sync. Name the new bead in the first `##`. If the session has a live non-terminal parent, the reply continues with exactly `## Дальше` (no task title on that heading) and `1/2/3` for the parent.

If creation is blocked, report the exact guard, command pattern used, and the minimal correction. Do not silently bypass policy.
