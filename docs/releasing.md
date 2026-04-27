# Releasing

Гайд по тому, как делать релизы приложения. Покрывает три сценария: обычный релиз новой версии, правку текстов release notes (Requirements / Installation и т.д.) и восстановление после поломок.

## TL;DR — кто за что отвечает

| Что нужно | Файл / команда |
|---|---|
| Добавить изменения для следующей версии | `CHANGELOG.md` — секция `## [Unreleased]` |
| Выбрать 3–5 главных Highlights | `CHANGELOG.md` — подсекция `### Highlights` внутри `[Unreleased]` |
| Поменять Requirements / Installation / macOS workaround | `.github/release-footer.md` |
| Поменять саму логику сборки (артефакты, платформы) | `.github/workflows/release.yml` |
| Поменять фильтры «что выкинуть из release notes» | `scripts/release-notes.py` |
| Запустить релиз | `./release.sh` в терминале |
| Опубликовать draft | `./release.sh --publish` или `gh release edit v<VERSION> --draft=false --latest` |

Если работаешь через Claude Code — фразы-триггеры для skills в [§ Skills](#skills).

---

## Сценарий 1: обычный релиз новой версии

Порядок: написать код → мёржить в main → собрать релиз.

### 1.1. Перед релизом

- Все нужные beads — в статусе `accepted` (не `in_progress`, не `inreview`).
- Все feature-ветки смёржены в `main` (skill **`merge-to-main`** или вручную).
- `pnpm test && npx vue-tsc --noEmit` — зелёные.
- `CHANGELOG.md` под `## [Unreleased]` содержит записи на **английском** под правильными подсекциями (`### Added`, `### Fixed`, `### Changed`, ...).

### 1.2. Запуск skill `release`

Скажи Claude: **«сделай релиз»** / **«пора релизить»** / **«prepare release»**.

Skill автоматически:

1. Проверит git state (ветка `main`, clean tree, `[Unreleased]` не пустой).
2. Проранжирует записи и запишет курированный блок `### Highlights` в `CHANGELOG.md` по правилам:
   - bd-compat / critical
   - net-new visible UX
   - long-standing fix
   - first-impression change
3. Сгенерирует **полный** preview release body (Highlights + What's New + Footer из `.github/release-footer.md`) и покажет.
4. Sanity-check footer'а — напр. что `Requires bd <version>` соответствует реальности.
5. Передаст тебе handoff на `./release.sh`.

Skill **не** запускает `release.sh` сам — это делает пользователь, потому что скрипт интерактивный и push необратим.

### 1.3. Запуск `./release.sh`

В терминале:

```bash
./release.sh
```

Скрипт спросит:

- **Шаг 3 (тесты)**: `y` если давно не гонял, `n` если только что.
- **Шаг 4 (версия)**: `1` patch / `2` minor / `3` major / `4` custom. Правило:
  - Только фиксы → patch (2.3.0 → 2.3.1)
  - Net-new фичи → minor (2.3.0 → 2.4.0)
  - Breaking changes → major (2.3.0 → 3.0.0)
- **Шаг 5 (promote `[Unreleased]` → `[vX.Y.Z]`)**: Enter = yes.
- **Шаг 7.5 (preview release notes)**: частичный preview — только Highlights + What's New из `scripts/release-notes.py`. Footer (Requirements / Installation / macOS workaround) в этот preview **не** попадает — он дописывается в CI. Полный preview с footer-ом — в skill `release` (Блок 3).
- **Шаг 9 (push тэга)**: default `N`. Набирай `y` только когда уверен — push тэга запускает GitHub Actions, создающие draft релиза.

### 1.4. Сборка в GitHub Actions

После push тэга:

- Workflow `Release` (см. `.github/workflows/release.yml`) собирает 6 артефактов (macOS ARM64/Intel `.dmg`, Linux `.deb`/`.AppImage`, Windows `.msi`/`.exe`).
- Для `v*` тэга: body = `scripts/release-notes.py` output + `---` separator + «See the full CHANGELOG» link + `.github/release-footer.md`.
- Для `latest` тэга: body = hardcoded «automatically generated development build» preamble + `.github/release-footer.md` (без `release-notes.py` — на `latest` скрипт не вызывается).
- Assets заливаются в **draft** релиз (`draft: true`).
- Сборка занимает ~8–15 минут.

Проверка:

```bash
gh run list --workflow=Release --limit 2
gh release view v<VERSION> --json assets -q '.assets[].name'
```

### 1.5. Smoke-тест

Скачай и запусти артефакт для своей платформы (через `gh release download`, т.к. draft assets требуют авторизации):

```bash
gh release download v<VERSION> -p "*macOS-ARM64.dmg" -D ~/Downloads
# Apple Silicon: после установки
xattr -cr /Applications/Beads\ Task-Issue\ Tracker.app
```

### 1.6. Публикация

Когда убедился, что билд работает:

```bash
./release.sh --publish
# или эквивалентно:
gh release edit v<VERSION> --draft=false --latest
```

Откат (если передумал):

```bash
gh release edit v<VERSION> --draft=true
```

---

## Сценарий 2: правка текстов release notes

### 2.1. Highlights / What's New конкретного релиза

→ `CHANGELOG.md`, секция этой версии (напр. `## [2.3.0]`), подсекции `### Highlights` / `### Added` / `### Fixed`.

Если релиз уже выпущен — правка `CHANGELOG.md` НЕ обновит release body автоматически (body заморожен при push тэга). Обновление существующего релиза:

```bash
# 1. Правим CHANGELOG.md (или готовим body руками во временный файл)
python3 scripts/release-notes.py 2.3.0 > /tmp/new-body.md
# 2. Дописываем footer вручную (должно точно повторять склейку из release.yml)
{ echo; echo "---"; echo; echo "See the [full CHANGELOG](https://github.com/Maxpceo/beads-task-issue-tracker/blob/main/CHANGELOG.md) for the complete history."; echo; cat .github/release-footer.md; } >> /tmp/new-body.md
# 3. Подменяем body на релизе
gh release edit v2.3.0 --notes-file /tmp/new-body.md
```

### 2.2. Requirements / Installation / macOS workaround (footer)

→ **Один файл: `.github/release-footer.md`**.

```bash
git checkout -b fix/release-footer-<что-меняешь>
# Правишь .github/release-footer.md (обычный markdown)
git add .github/release-footer.md
git commit -m "docs(release): update <что>"
git push -u origin HEAD
gh pr create --base main --fill
# После merge в main — следующий v* тэг автоматически подхватит
```

Типичные поводы править footer:

| Изменилось | Что править в `.github/release-footer.md` |
|---|---|
| Bumped bd major (1.0 → 2.0) | строка `> **Requires bd ...**` |
| Новая платформа (напр. Linux arm64) | таблица Installation (+ добавить matrix entry в workflow) |
| Apple Developer signing появился | удалить секцию «macOS — unsigned app workaround» |
| Переименование artifact (`_macOS-ARM64` → `_macOS-AppleSilicon`) | таблица Installation **+** rename-блоки в `.github/workflows/release.yml` |

Для **уже выпущенного** релиза правка footer-файла не влияет — нужно патчить body через `gh release edit --notes-file ...` (см. §2.1).

### 2.3. Что выкидывается из release notes

→ `scripts/release-notes.py` — фильтры в секции `FILTERED_SUBSECTIONS` (dropped `### Internal` / `### DX` / `### CI` / `### Docs` etc.) и ключевые слова в `is_internal_bullet()`.

Если видишь, что что-то user-facing попало в фильтр (или наоборот — dev-tooling просочилось) — редактируй `release-notes.py`, добавь unit-тест, PR обычным способом.

---

## Сценарий 3: поломки и восстановление

### 3.1. Windows job упал, `.msi` не залился

Обычно либо `UnicodeEncodeError` в `release-notes.py` (лечится `sys.stdout.reconfigure(encoding='utf-8')`), либо flaky bundle. Решение:

1. Фиксим script / workflow на feature-ветке.
2. Мёржим в main.
3. **Перетэгиваем** — существующий draft сохранится, workflow догрузит недостающие артефакты:

   ```bash
   git push --delete origin v<VERSION>
   git tag -d v<VERSION>
   git checkout main && git pull
   git tag v<VERSION>
   git push origin v<VERSION>
   ```

4. Существующие assets получат `422 Validation Failed` на повторную загрузку — это норма, они и так на месте. Главное — что **упавшие** платформы теперь зальются.

### 3.2. Release body содержит устаревший текст

- Если **footer** устарел (Requirements и т.д.) → правь `.github/release-footer.md`, merge to main, затем для уже выпущенных релизов патчь body вручную (§2.1).
- Если **Highlights** выбраны плохо → правь `CHANGELOG.md`, перегенерируй body по тому же шаблону, что в §2.1:

  ```bash
  python3 scripts/release-notes.py <version> > /tmp/body.md
  { echo; echo "---"; echo; echo "See the [full CHANGELOG](https://github.com/Maxpceo/beads-task-issue-tracker/blob/main/CHANGELOG.md) for the complete history."; echo; cat .github/release-footer.md; } >> /tmp/body.md
  gh release edit v<version> --notes-file /tmp/body.md
  ```

### 3.3. Артефакт не скачивается (TLS timeout, 404)

- `release-assets.githubusercontent.com` может быть недоступен с некоторых сетей (Azure CDN) — попробуй VPN или мобильный интернет.
- Draft-assets требуют auth: скачивай через `gh release download` (использует твой токен), а не прямую ссылку из браузера.

---

## Skills (шорткаты для Claude Code) {#skills}

Все триггеры — обычные фразы на русском/английском.

| Skill | Когда запускается | Что делает |
|---|---|---|
| **`release`** | «сделай релиз», «пора релизить», «prepare release» | Всё из §1.2 — pre-flight, курация Highlights, preview body, handoff |
| **`merge-to-main`** | «мёржим в main», «создай PR» | feature-branch → PR → CI watch → merge-slot → merge → checkout main |
| **`land`** | «я закончил», «давай заканчивать», «сохрани работу» | Закрыть beads, commit, push на feature-ветку (через merge-slot) |

Порядок на большой фиче: `land` (внутри сессии) → `merge-to-main` (завершение ветки) → `release` (новая версия).

---

## Файлы и их роли

```
CHANGELOG.md                      ← per-release контент: Highlights + Added/Fixed/...
scripts/release-notes.py          ← парсер CHANGELOG → чистый markdown (фильтрует internal/dev)
.github/release-footer.md         ← Requirements + Installation + macOS workaround
.github/workflows/release.yml     ← CI: сборка артефактов, склейка body, upload assets
release.sh                        ← интерактивный локальный запуск (version bump, tag, push)
.claude/skills/release/SKILL.md   ← процедура для Claude (блоки 1–4)
.claude/references/release-workflow.md ← справочник для Claude
docs/releasing.md                 ← этот файл
```

### Ментальная модель

```
release body = [ scripts/release-notes.py OUTPUT ] + [ .github/release-footer.md ]
                         ↑                                    ↑
             читает CHANGELOG.md, фильтрует           статичный текст,
             internal/dev noise                       правится отдельно от релиза
```

Всё остальное — обвязка вокруг этой формулы.
