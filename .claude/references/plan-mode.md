# Plan Mode — сохранение утверждённого плана

Базовая константа (всегда в L1 `CLAUDE.md`): `Save plans in .claude/plans/, never ~/.claude/plans/`. Этот файл — полный формат и обоснование.

## Save approved plan

Если задача прошла через Plan Mode и получила approval — сохрани утверждённый план как артефакт **до** диспатча любого supervisor'а:

- **Preferred:** `.claude/plans/{bead-id}.md` с телом плана.
- **Alternative:** `bd update {ID} --design "PLAN (approved YYYY-MM-DD): ..."`.

## Формат

```
PLAN (approved YYYY-MM-DD)
Problem: <1-2 sentences>
Approach: <what we do>
Rejected alternatives: <what we considered and why we declined — protects against drift on re-dispatch>
Files to change: <paths>
Acceptance: <how we will verify>
```

## Why

План переживает сессию. При `NOT APPROVED` и re-dispatch'е supervisor видит оригинальный план. Reviewer cross-check'ает его во время Phase 1 spec compliance. Rejected alternatives записаны — никто не «забудет» и не сделает иначе.

## Skip

Для мелких фиксов, которые не использовали Plan Mode, ничего сохранять не нужно.
