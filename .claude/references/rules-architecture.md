# Rules Architecture — куда класть новое правило / hook / skill

Проект использует 5-уровневую lazy-loaded архитектуру для правил. Когда у пользователя возникает «запомни X» или «добавь правило Y» — сверяйся с этим файлом, чтобы положить в правильное место (а не раздуть L1 `CLAUDE.md`).

## Уровни

| Уровень | Артефакт | Активация | Аудитория |
|---|---|---|---|
| **L1** | `CLAUDE.md` (root, ≤200 строк) | Всегда, каждая сессия | orchestrator + все subagents |
| **L2** | nested `CLAUDE.md` (`src-tauri/CLAUDE.md`, возможно в будущем `app/`, `tests/`) | Lazy: при `Read` файла из папки или `cd` в неё | orchestrator + supervisors |
| **L3** | `.claude/rules/*.md` с `paths:` frontmatter | Lazy: при `Read` matching файла | все |
| **L4** | `.claude/skills/*/SKILL.md` | Проактивный семантический trigger по `description:` | **только orchestrator** |
| **L5** | `.claude/hooks/*.sh` + `.claude/settings.json` | Детерминистически на события (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `SessionStart`, `Stop`, `Notification`) | все действия проходят через hooks |

## Дополнительные точки

| Артефакт | Активация | Аудитория |
|---|---|---|
| `.claude/agents/*.md` body | При `Task` dispatch на соответствующий subagent | Только этот subagent |
| `.claude/references/*.md` | Явный `Read` по ссылке из CLAUDE.md / nested / agent body | Тот, кто читает |
| `bd remember` / persistent memory | Session start (только orchestrator через hook) | Только orchestrator |

**Философия:** root CLAUDE.md — минимум постоянной нагрузки. Всё остальное lazy. Нулевые токены пока контекст не нужен.

## Decision Tree — что куда класть

| Характер правила | Примеры | Уровень |
|---|---|---|
| Always-on константа для всех агентов (<1 строки) | «Evidence before claims», «Iron Law», labels | **L1 root CLAUDE.md** |
| Domain-specific для одной поддиректории | bd Version Compat для `src-tauri/`, Vue composable patterns для `app/composables/` | **L2 nested CLAUDE.md** |
| Cross-cutting rule, активируется по именам файлов | «no `console.*` в `app/`», UI Constraints для `*.vue` | **L3 `.claude/rules/*.md`** с `paths:` |
| Многошаговый workflow для orchestrator | merge-to-main, subagents-discipline, release | **L4 `.claude/skills/*/SKILL.md`** |
| Детерминистическая блокировка на событии | block supervisor close, enforce bead on large commit | **L5 `.claude/hooks/*.sh`** + регистрация в `.claude/settings.json` |
| Контекст только для одного supervisor типа | TDD phases для test-supervisor, Vue conventions для vue-supervisor | **agent body** `.claude/agents/*-supervisor.md` |
| Usage reference / шаблоны / команды | bd-commands, release-workflow, plan-mode | **`.claude/references/*.md`** + citation |
| Learned lesson / gotcha / preference | «bd 0.57+ has auto-flush», workaround истории | **persistent memory** (`bd remember`) |

### Уточняющие вопросы для пограничных случаев

**L1 vs L2:**
- Нужно ли правило в любой папке? → L1, иначе L2
- Это одна строка или абзац? → строка L1, абзац L2

**L2 vs L3:**
- Правило специфично одной папке? → L2, иначе L3
- Нужна привязка к glob-именам файлов? → нет L2, да L3

**L4 vs agent body:**
- Workflow только orchestrator'а? → skill, иначе agent body
- Нужен семантический trigger? → skill, иначе agent body

**Hook vs rule:**
- Нужно **заблокировать** действие? → hook, иначе rule
- Срабатывает на событие (commit/bash/task)? → hook, иначе rule

## Ограничения Claude Code — учитывай при выборе

Эти ограничения фундаментальные и проверены экспериментально:

| Ограничение | Последствие для архитектуры |
|---|---|
| **Subagents (Task-based) НЕ наследуют skills orchestrator'а** | Не пиши supervisor workflow в skills. Для supervisor — agent body или rules с paths |
| **Subagents НЕ видят memory** (`bd prime`, `bd memories`) | Для supervisor'а — persistent knowledge только через файл (reference/rule/nested), ссылаемый из agent body |
| **Rules с `paths:` срабатывают только при `Read`, НЕ при `Write`** (bug Claude Code) | Если нужно правило на создание файла — писать в agent body или CLAUDE.md |
| **Nested CLAUDE.md активируется при `Read` или `cd`, НЕ при `Grep`/`Glob`** | Новый файл в папке через `Write` может не получить nested контекст — упоминать критичное в root |
| **Agent body инжектируется ОДИН РАЗ при dispatch** | Нельзя обновить body mid-work — redispatch с новым body |
| **Hooks блокируют, но не объясняют** | Для educational reason — reference + ссылка из stderr сообщения hook'а |

## Glob syntax для `paths:` frontmatter

- Поддерживается стандартный glob (`**/*.ts`, `src-tauri/src/**/*.rs`)
- **Не** используй brace expansion (`{ts,vue}`) — ненадёжно, пиши **раздельными entries**:
  ```yaml
  paths:
    - "app/**/*.ts"
    - "app/**/*.vue"
  ```
- YAML массив обязателен (не одна строка)

## Anti-patterns (не делай)

| Anti-pattern | Почему плохо | Правильно |
|---|---|---|
| Workflow в root CLAUDE.md | Инжектируется в каждую сессию = bloat | `.claude/skills/*/SKILL.md` |
| Domain rule в нескольких agent bodies | Дублирование, рассинхронизация | `.claude/rules/*.md` с paths |
| Enforcement в CLAUDE.md | Надежда на память агента | Hook с `exit 1` |
| Learned lesson в hook | Hook не объясняет, только блокирует | `bd remember` + reference |
| Skill для subagent workflow | Subagent skill не унаследует | Agent body или rules |
| Дублирование одного правила в двух местах | Рассинхронизация при update | Одно правило — один механизм |
| Раздутый nested CLAUDE.md (>300 строк) | Тот же bloat, просто перенесённый | Разбить на дополнительные rules + references |

## Примеры для Tauri / Vue / Rust / beads stack

1. **«Не использовать `console.*` в `app/`»** → L3 `.claude/rules/logging.md` с `paths: ["app/**/*.ts", "app/**/*.vue"]`. Причина: cross-cutting правило, срабатывает на любом TS/Vue файле.
2. **«Rust-бэкенд проверяет `project_uses_dolt()` перед skip legacy»** → L2 `src-tauri/CLAUDE.md`. Причина: специфично `src-tauri/`.
3. **«Supervisor после commit+push ставит `inreview`»** → **agent body** supervisor'ов (через `discovery.md` injection) + L1 ownership boundary. Причина: только supervisor'ы, не нужно другим subagents.
4. **«Запретить `git add -A` в сессии»** → L5 hook `PreToolUse` на `Bash` с matcher. Причина: детерминистическая блокировка.
5. **«Merge-to-main workflow с обновлением CHANGELOG/README и ожиданием CI»** → L4 skill `merge-to-main`. Причина: многошаговый orchestrator-only workflow.
6. **«Iron Law: не использовать hedging language в completion reports»** → L1 root CLAUDE.md (Always-on) + L4 skill `subagents-discipline` (полный banned-phrase list). Причина: критично для каждого completion report, но детали в skill.

## Когда создавать новый уровень артефакта

- **Новый `.claude/rules/*.md`** — когда правило пересекает 2+ файла одного типа (напр. все `.vue`).
- **Новый `.claude/skills/*/SKILL.md`** — когда workflow состоит из 3+ шагов и применяется регулярно.
- **Новый `.claude/hooks/*.sh`** — когда действие **должно** быть заблокировано (не просто напомнено).
- **Новый nested `CLAUDE.md`** — когда поддиректория накопила 30+ строк domain-specific правил.
- **Новый `.claude/references/*.md`** — когда reference-материал >15 строк и используется по ссылке, не всегда.

Если ни один из этих уровней не подходит — не добавляй ничего. Возможно, правило уже есть в другом артефакте, или оно слишком узкое, чтобы его стоило формализовать.
