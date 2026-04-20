---
name: land
description: "Завершение рабочей сессии — закрытие beads, коммит, push на remote feature-ветку через merge-slot. Используй этот скилл ПРОАКТИВНО когда пользователь говорит: я закончил, пора заканчивать, всё на сегодня, хватит на сегодня, закончить работу, давай заканчивать, landing the plane, push всё, запуши изменения, сохрани работу. НЕ путай с merge-to-main: land = commit+push в feature-ветку внутри сессии; merge-to-main = финальный PR → merge в main → checkout main."
---

# Landing the Plane — Завершение сессии

Работа НЕ завершена, пока `git push` не будет успешным.

Максимизируй параллельные вызовы — объединяй независимые команды в один bash-вызов через `&&` или `;`.

## Разведение с merge-to-main

`land` = commit + push в текущую feature-ветку **внутри сессии**, чтобы работа не пропала и параллельные сессии увидели актуальный код. `merge-to-main` = финальный PR → merge в main → checkout main, запускается **после** того, как все beads ветки приняты (`accepted`/`closed`).

Если пользователь говорит «давай мержить в main», «создай PR», «влей в main» — это `merge-to-main`, не `land`.

## Блок 1: Состояние (один вызов git + один вызов bd — ПАРАЛЛЕЛЬНО)

Запусти ОБА вызова одновременно:

**Вызов 1:**
```bash
git status --short && echo "===BRANCH===" && git branch --show-current
```

**Вызов 2:**
```bash
bd list --status=in_progress 2>/dev/null; echo "===INREVIEW==="; bd list --status=inreview 2>/dev/null
```

Покажи пользователю кратко: ветка, изменённые файлы, статус beads.

Для beads со статусом `inreview` — проверь comments на "APPROVED":
- APPROVED → `bd close {ID}`
- Нет APPROVED → сообщи пользователю
- `in_progress` → сообщи пользователю (не закрывай)

## Блок 2: Commit (код + beads)

Если есть изменения в коде (не .beads/):
```bash
git add <файлы> && git commit -m "$(cat <<'EOF'
описание изменений

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Затем beads (если есть изменения в .beads/):
```bash
git add .beads/ && git diff --cached --quiet || git commit -m "sync beads"
```

## Блок 3: Push + Verify (через merge-slot)

Push выполняется через `bd merge-slot` для сериализации с параллельными сессиями — две сессии не могут одновременно `pull --rebase && push` и создать cascading-конфликты.

**Важно: если `bd merge-slot acquire` упал (non-zero exit, `Slot held by X` или другая ошибка) — STOP, НЕ вызывай `git pull --rebase && git push`.** Merge-slot advisory: `git push` не знает про него и отправит коммиты без сериализации, создавая гонку с параллельной сессией (non-fast-forward, cascading rebase). Покажи пользователю `bd show beads-<repo>-merge-slot` и спроси (wait / queue `--wait` / abort). Без явного согласия не форсируй.

```bash
if ! bd merge-slot acquire; then
  bd show beads-<repo>-merge-slot  # покажи holder
  # STOP. Спросить пользователя, не делать git push.
fi
git pull --rebase && git push && echo "===OK===" && git log --oneline -3
bd merge-slot release
```

**На любой ошибке** (конфликт rebase, push rejected, и т.д.) — ОБЯЗАТЕЛЬНО `bd merge-slot release` до того, как сообщать пользователю. Неотпущенный слот заблокирует остальные сессии до ручного release.

Покажи пользователю итог:
- Что закоммичено
- Какие beads закрыты
- Незакрытые beads (контекст для следующей сессии)
