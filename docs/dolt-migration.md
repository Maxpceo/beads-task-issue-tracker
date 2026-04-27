# Миграция на Dolt — Внутренние заметки

## Контекст

Начиная с bd >= 0.50, бэкенд Dolt заменяет SQLite. Существующие проекты необходимо мигрировать.

## Что произошло в beads-task-issue-tracker (2026-02-18)

### Симптом

- После обновления до bd 0.52 проект показывал пустую страницу (0 issues)
- `bd list` возвращал `[]` без ошибки
- Папка `.beads/dolt/` существовала (частичная миграция), но `.beads/.dolt` отсутствовал

### Причина

bd 0.52 автоматически запустил частичную миграцию (вероятно, при операции записи).
Папка `dolt/` была создана, но миграция не завершилась. bd читал из Dolt (пустого) вместо SQLite.

### Процедура восстановления

```bash
# 1. Проверить, что JSONL содержит issues (источник истины)
wc -l .beads/issues.jsonl

# 2. Убить все процессы bd/dolt, которые могут блокировать базу
pkill -f "bd doctor"; pkill -f "bd daemon"; pkill -f dolt
rm -f .beads/daemon.lock .beads/daemon.pid .beads/bd.sock .beads/dolt-access.lock .beads/.jsonl.lock

# 3. Удалить повреждённый/частичный dolt и повреждённую SQLite
rm -rf .beads/dolt .beads/beads.db .beads/beads.db-shm .beads/beads.db-wal

# 4. Переинициализировать с правильным префиксом (проверить в issues.jsonl)
bd init --prefix beads

# 5. Отфильтровать tombstone-issues (bd 0.52 их отклоняет) и импортировать
python3 -c "
import json
with open('.beads/issues.jsonl') as f:
    with open('/tmp/beads-clean.jsonl', 'w') as out:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                issue = json.loads(line)
                if issue.get('status') == 'tombstone': continue
                out.write(json.dumps(issue) + '\n')
            except: continue
"
bd import -i /tmp/beads-clean.jsonl

# 6. Проверить
bd count
bd list --limit=5
```

### Важные моменты

- **JSONL — источник истины**: пока он цел, issues можно восстановить
- **Tombstone-issues** (в нашем случае 106) — это удалённые issues. bd 0.52 отклоняет их при импорте, это нормально
- **Префикс должен совпадать**: `bd init --prefix X` должен соответствовать префиксу ID issues в JSONL (например: `beads-0bn` → префикс `beads`)
- **Блокировки Dolt**: `bd doctor` может создать блокировку и заблокировать сам себя. Всегда убивайте существующие процессы перед повторной попыткой
- **`bd migrate --to-dolt`** требует базу SQLite. Если она была удалена, используйте `bd init` + `bd import` вместо этого

## Риск для других проектов

Частичная миграция может произойти, если:

1. Установлен bd 0.52
2. Выполняется команда записи (`bd update`, `bd create` и т.д.) в проекте с SQLite
3. Автоматическая миграция завершается с ошибкой или прерывается

**Признаки**:

- Папка `.beads/dolt/` существует, но `bd list` возвращает `[]`
- Присутствует файл `.beads/dolt-access.lock`
- `bd list` возвращает ошибку "Dolt backend configured but database not found"

## Обнаружение в приложении

Приложение определяет 3 случая:

1. **Явная ошибка**: "Dolt backend configured but database not found" → перехватывается `isDoltMigrationError()` в catch-блоках
2. **Проактивное обнаружение**: `bd_check_needs_migration` проверяет, что bd >= 0.50 + проект не на Dolt + есть существующие данные
3. **Частичная миграция**: папка `dolt/` существует, но `.dolt` отсутствует

Команда `bd_migrate_to_dolt` очищает частичную папку `dolt/` перед повторным запуском `bd migrate --to-dolt --yes`.
