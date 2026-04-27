---
name: release
description: "Подготовка нового релиза — pre-flight checks, курация секции ### Highlights в CHANGELOG [Unreleased] по правилам ранжирования (bd-compat / net-new visible UX / long-standing fix / first-impression change), preview release body через scripts/release-notes.py, handoff на ./release.sh. Используй этот скилл ПРОАКТИВНО когда пользователь говорит: сделай релиз, давай сделаем релиз, пора релизить, готовь релиз, подготовь релиз, release prep, prepare release, make a release, release version. НЕ путай с merge-to-main (финальный PR → merge в main) и land (commit+push в feature-ветку). Skill НЕ запускает release.sh сам — это делает пользователь в терминале после preview, потому что release.sh интерактивный и push необратим."
---

# Release Preparation — Подготовка релиза

> **Execution style** — см. `CLAUDE.md § Workflow Execution Style` (без промежуточных вопросов включая переходы между skill'ами + табличный итоговый отчёт).

Цель этого skill'а: довести проект до состояния, готового к `./release.sh`, за счёт курации пользовательских Highlights и предпросмотра release body. Сам `release.sh` запускает пользователь в своём терминале.

## Разведение с соседними skills

- **`land`** — commit + push в feature-ветку внутри сессии. Ничего не релизит.
- **`merge-to-main`** — финальный PR → merge в main. Должен отработать ДО `release`.
- **`release`** (этот skill) — подготовка `### Highlights` + preview release body. Не мутирует git-состояние (только CHANGELOG.md).
- **`./release.sh`** — боевой релиз: bump версии, tag, push, запуск GitHub Actions. Запускается пользователем вручную.

Порядок: все beads accepted → `merge-to-main` → `release` (этот skill) → пользователь запускает `./release.sh`.

## Блок 1: Pre-flight checks (параллельно)

Запусти ОБА вызова одновременно:

**Вызов 1 — git state:**

```bash
git status --short && echo "===BRANCH===" && git branch --show-current && echo "===AHEAD===" && git rev-list --count origin/main..HEAD 2>/dev/null
```

**Вызов 2 — CHANGELOG state:**

```bash
awk '/^## \[Unreleased\]/{p=1;next} /^## \[/{p=0} p' CHANGELOG.md | head -80
```

Проверки и условия прерывания:

| Условие | Действие |
|---|---|
| Не на `main` | STOP. Скажи пользователю: «Сначала merge-to-main, потом release.» |
| Dirty tree (есть `M`/`??`) | STOP. Предложи `land` или явный коммит. |
| Unreleased пустой | STOP. «Нечего релизить — в [Unreleased] нет записей.» |
| В Unreleased prose есть кириллица (кроме quoted examples / i18n values / hash-parity paths) | Предупреди пользователя: «В [Unreleased] есть русские записи — CHANGELOG должен быть на английском (см. CLAUDE.md §Session Completion). Перевести?» |
| `### Highlights` уже существует | Спроси пользователя: (a) переписать заново, (b) оставить как есть, (c) показать текущий + предложить правки. |

Если все проверки OK — переходи к Блоку 2.

## Блок 2: Ранжирование и запись Highlights

Прочитай полное содержимое `[Unreleased]` секции CHANGELOG (секции `### Added`, `### Fixed`, `### Changed`, `### Removed`). Для каждой записи примени **алгоритм ранжирования**:

1. **Critical / compat** — блокирует использование новой версии, адаптация под upstream (напр. «bd 1.0.x compatibility»). **Всегда в топ.**
2. **Net-new visible UX** — новая фича, которую пользователь видит в первую минуту использования (напр. «Cmd+K palette», «Custom status colors»). **Высокий приоритет.**
3. **Long-standing fix** — давний раздражающий баг (напр. «No more phantom toasts on project switch»). **Высокий приоритет — снимает трение.**
4. **First-impression change** — заметное UX-изменение, которое меняет восприятие приложения (напр. «Runtime language switcher», редизайн).
5. **Power-user-only / internal / performance instrumentation / extract utility / rename** — **пропускай.** Они в CHANGELOG остаются, но не в Highlights.

Выбери **3–5 пунктов** — не больше. Пять равнозначно важных → бери 5. Один явный доминант → можно 3.

**Формат каждого bullet:**

- `- **Short title (3–6 слов)** — one-line user-facing value (без bead-IDs, без имён файлов/функций, без технических деталей).`
- Язык: английский (CHANGELOG — English only, см. CLAUDE.md).
- Группируй родственное: три мелких bullet'а про bd compat → один обобщённый «Full bd 1.0.x compatibility — ...».

**Запись в CHANGELOG** через Edit:

- Вставляй секцию `### Highlights` между `## [Unreleased]` и первой из `### Added/Fixed/Changed/...`.
- Пустая строка до и после секции.
- Не переписывай другие секции.

**Пример того, что должно получиться:**

```markdown
## [Unreleased]

### Highlights
- **Full bd 1.0.x compatibility** — the app now speaks bd's new review chain, custom statuses, and three new issue types (`spike`/`story`/`milestone`).
- **Custom status colors in Settings** — pick any colour (solid or gradient) for every status; per-project, persisted locally.
- **Cmd+K cross-project command palette** — Linear/VS Code-style search across every project in the sidebar.
- **No more phantom "Task deleted" toasts** when switching between projects.
- **Runtime language switcher** — Auto / English / Русский in Settings, with full UI localization.

### Added
- (full list, untouched)
...
```

После записи покажи пользователю **обоснование каждого пункта** в одной строке:

- *«bd 1.0.x — critical compat; Custom colors — net-new visible UX; Cmd+K — net-new visible UX; toasts — long-standing fix; language switcher — first-impression change»*

Это даёт пользователю шанс оспорить выбор до preview.

## Блок 3: Preview release body (Highlights + What's New + Footer)

Release body = Highlights/What's New (из CHANGELOG, через `release-notes.py`) + **Footer** (`.github/release-footer.md`: Requirements, Installation, macOS workaround).

Запусти полный preview в том же порядке, в каком workflow собирает body:

```bash
{ python3 scripts/release-notes.py Unreleased; echo; echo "---"; echo; echo "See the [full CHANGELOG](https://github.com/Maxpceo/beads-task-issue-tracker/blob/main/CHANGELOG.md) for the complete history."; echo; cat .github/release-footer.md; } 2>&1 | head -80
```

Проверки:

- Если в stderr есть `note: no curated ### Highlights section found` — значит секция не попала туда, куда нужно. Перечитай CHANGELOG, исправь расположение.
- Если output содержит секцию `## Highlights` с записанными тобой пунктами — OK.
- Если секции `## What's New` содержат `### Highlights` (дублирование) — баг в скрипте (фильтр в `release-notes.py`).
- **Footer sanity-check**: `## Requirements` упоминает **актуальную версию bd** (сейчас `1.0.x`). Если в footer устарел bd/Installation/macOS workaround — правь **только `.github/release-footer.md`** (single source of truth для footer); workflow делает `cat` этого файла в двух местах (v* и latest).

### Когда править footer

| Изменилось | Действие |
|---|---|
| Bumped bd major (e.g. 1.0 → 2.0) | обнови строку `> **Requires bd ...**` |
| Новая платформа/artifact | добавь строку в таблицу Installation |
| Apple Developer signing появился | удали секцию «macOS workaround» |
| Переименование artifact (e.g. `_macOS-ARM64` → `_macOS-AppleSilicon`) | синхронно поправь таблицу Installation + rename-блоки в `.github/workflows/release.yml` |

Правки footer'а идут отдельным PR (не в release-коммите). После merge в main — следующий тег `v*` автоматически подхватит новый footer.

## Блок 4: Handoff

Финальное сообщение пользователю:

> **Готово.** В терминале запусти:
>
> ```
> ./release.sh
> ```
>
> Пройди по шагам. Ориентиры:
>
> - Шаг 3 (тесты): `y` если давно не гонял, `n` если только что прогонял.
> - Шаг 4 (версия): обычно `2` (minor bump) если есть новые фичи, `1` (patch) если только фиксы.
> - Шаг 5 (promote `[Unreleased]`): Enter = yes.
> - Шаг 7.5 (preview): проверь ещё раз, что Highlights выглядят как ожидаешь.
> - **Шаг 9 (push)**: default `N` — набери `y` только когда уверен. Это необратимо: GitHub Actions создаст публичный draft-релиз.
>
> После `release.sh`: подожди ~10–15 минут пока GitHub Actions соберёт артефакты, проверь через `gh release view v<VERSION>`, затем `./release.sh --publish` чтобы снять черновик.
