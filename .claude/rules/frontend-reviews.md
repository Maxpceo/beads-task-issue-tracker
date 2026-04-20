---
name: frontend-reviews
description: RAMS accessibility + Web Interface Guidelines выполняются orchestrator'ом через skill `reviewing-code` после `inreview` (plugin skills не наследуются subagent'ами).
paths:
  - "app/components/**/*.vue"
  - "app/pages/**/*.vue"
---

## Frontend Reviews (RAMS + WIG) — orchestrator step

**Важно:** RAMS и web-interface-guidelines — это plugin skills. Subagent'ы (vue-supervisor и пр.) их **не наследуют** и не могут вызывать `Skill()`. Поэтому supervisor НЕ запускает RAMS/WIG.

### Supervisor workflow (внутри subagent)

```
Implement → Run pnpm test + vue-tsc --noEmit → Commit → Mark inreview (через --status inreview)
```

После этого supervisor завершает работу. Любой результат RAMS/WIG из supervisor body — устаревший хардкод.

### Orchestrator workflow (после возврата supervisor'а)

Запускается skill `reviewing-code`:

```
inreview → simplify → code review (двухэтапный) → RAMS + WIG для каждого .vue в diff → locale-sync → acceptance → close
```

Конкретные команды:

```python
# Для каждого модифицированного компонента:
Skill(skill="rams", args="path/to/Component.vue")
Skill(skill="web-interface-guidelines")
```

**Audit trail в bead:**
```bash
bd comments add {BEAD_ID} "Reviews: RAMS 95/100, WIG passed. Fixed: [issues if any]"
```

Если RAMS находит CRITICAL accessibility issues или WIG — violations → orchestrator делает redispatch vue-supervisor с fix list.

Полный workflow: `.claude/skills/reviewing-code/SKILL.md` Step 2.5.
