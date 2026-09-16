import { describe, expect, it } from 'vitest'

import planReviewExtension, {
  classifyPlanReviewRisk,
  evaluatePlanReviewGate,
  findInvalidSequentialReasons,
  hasImportantOrCriticalFindings,
  missingRevisedPlanSections,
  parsePlanReviewOutput,
  planReviewStopAdvice,
  runPlanReviewers,
  type PlanReviewResult,
} from '../../.pi/extensions/plan-review/index'

describe('plan-review gate helpers', () => {
  it('exports a no-op extension factory for the Pi extension loader', () => {
    expect(typeof planReviewExtension).toBe('function')
    expect(planReviewExtension({} as never)).toBeUndefined()
  })

  it('parses structured reviewer verdicts and findings', () => {
    const result = parsePlanReviewOutput('plan-edge-reviewer', `PLAN REVIEW: NEEDS_CHANGES
Findings:
- severity: important
  issue: Missing rollback for failed reviewer
  evidence: plan says execute after review
  suggested fix: block auto-execute on reviewer failure
Unresolved blockers: none`)

    expect(result).toMatchObject({ reviewer: 'plan-edge-reviewer', verdict: 'NEEDS_CHANGES', unresolvedBlockers: [] })
    expect(result.findings[0]).toMatchObject({ severity: 'important', issue: 'Missing rollback for failed reviewer' })
  })

  it('blocks the gate when a required reviewer is missing or blocked', () => {
    const gate = evaluatePlanReviewGate([
      { reviewer: 'plan-edge-reviewer', verdict: 'APPROVED', findings: [], unresolvedBlockers: [], raw: '' },
      { reviewer: 'plan-consistency-reviewer', verdict: 'BLOCKED', findings: [], unresolvedBlockers: ['missing acceptance'], raw: '' },
    ])

    expect(gate.ok).toBe(false)
    expect(gate.missingReviewers).toEqual(['plan-dead-zone-reviewer'])
    expect(gate.reasons).toEqual(expect.arrayContaining([
      'missing reviewer: plan-dead-zone-reviewer',
      'blocked reviewer: plan-consistency-reviewer',
      'unresolved blocker: plan-consistency-reviewer: missing acceptance',
    ]))
  })

  it('requires revised-plan adjudication sections before auto-execute', () => {
    const missing = missingRevisedPlanSections(`Reviewer findings summary:
- ok
Accepted findings:
- none
Rejected findings:
- none
Unresolved blockers: none
Revised plan:
1. Implement
Files to change:
- .pi/extensions/plan-mode/index.ts
Acceptance:
- tests pass
Risks / rollback:
- revert
`)

    expect(missing).toEqual(['AUTO_EXECUTE_ALLOWED: true'])
  })

  it('rejects vague sequential reasons and accepts whitelisted ones in the matrix', () => {
    const invalidPlan = `| Stream | Goal | Agent | Write zone | Dependencies | Verification | Decision | Reason |
|---|---|---|---|---|---|---|---|
| A | Update docs | docs supervisor | .pi/skills/plan-bead/SKILL.md | none | rg matrix | sequential | files are related |`
    const validPlan = invalidPlan.replace('files are related', 'dependency chain: tests consume the docs contract')
    const invalidRussianPlan = `| Поток | Цель | Агент | Зона изменений | Зависимости | Проверка | Решение | Причина |
|---|---|---|---|---|---|---|---|
| A | Обновить docs | docs supervisor | .pi/skills/plan-bead/SKILL.md | нет | rg matrix | sequential | files are related |`
    const validRussianPlan = invalidRussianPlan.replace('files are related', 'dependency chain: tests consume the docs contract')

    expect(findInvalidSequentialReasons(invalidPlan)).toEqual([
      'Sequential stream row 3 has unsupported reason: files are related',
    ])
    expect(missingRevisedPlanSections(invalidPlan)).toContain('Sequential stream row 3 has unsupported reason: files are related')
    expect(findInvalidSequentialReasons(validPlan)).toEqual([])
    expect(findInvalidSequentialReasons(invalidRussianPlan)).toEqual([
      'Sequential stream row 3 has unsupported reason: files are related',
    ])
    expect(findInvalidSequentialReasons(validRussianPlan)).toEqual([])
  })

  it('planReviewStopAdvice exclusive matrix ignores risk and caps at cycle 2', () => {
    expect(planReviewStopAdvice({ cycle: 1, gateOk: false, hasImportantOrCritical: false })).toBe('HARD_BLOCK')
    expect(planReviewStopAdvice({ cycle: 1, gateOk: false, hasImportantOrCritical: true })).toBe('HARD_BLOCK')
    expect(planReviewStopAdvice({ cycle: 2, gateOk: false, hasImportantOrCritical: true })).toBe('HARD_BLOCK')

    expect(planReviewStopAdvice({ cycle: 1, gateOk: true, hasImportantOrCritical: false })).toBe('STOP_SHOW_USER')
    expect(planReviewStopAdvice({ cycle: 2, gateOk: true, hasImportantOrCritical: false })).toBe('STOP_SHOW_USER')

    expect(planReviewStopAdvice({ cycle: 1, gateOk: true, hasImportantOrCritical: true })).toBe('CONTINUE')
    expect(planReviewStopAdvice({ cycle: 0, gateOk: true, hasImportantOrCritical: true })).toBe('CONTINUE')
    expect(planReviewStopAdvice({ cycle: 2, gateOk: true, hasImportantOrCritical: true })).toBe('STOP_SHOW_USER')
    expect(planReviewStopAdvice({ cycle: 3, gateOk: true, hasImportantOrCritical: true })).toBe('STOP_SHOW_USER')
  })

  it('classifyPlanReviewRisk is telemetry-only with FAST_PATH sticker and denylist', () => {
    expect(classifyPlanReviewRisk('Plan:\n1. docs only')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: single markdown file\nFiles: docs/note.md')).toBe('low')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: .pi/extensions/plan-mode/index.ts')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: .pi/skills/plan-bead/SKILL.md')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: .pi/agents/plan-edge-reviewer.md')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: .pi/rules/domain.md')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: scripts/ping.sh')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: app/pages/index.vue and src-tauri/src/lib.rs')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: app/utils/helpers.ts')).toBe('low')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: src-tauri/src/lib.rs')).toBe('low')
  })

  it('gate.ok still ignores NEEDS_CHANGES while important findings are visible for stop advice', () => {
    const results: PlanReviewResult[] = [
      {
        reviewer: 'plan-edge-reviewer',
        verdict: 'NEEDS_CHANGES',
        findings: [{ severity: 'important', issue: 'missing rollback', evidence: 'plan', suggestedFix: 'add rollback' }],
        unresolvedBlockers: [],
        raw: '',
      },
      { reviewer: 'plan-consistency-reviewer', verdict: 'APPROVED', findings: [], unresolvedBlockers: [], raw: '' },
      { reviewer: 'plan-dead-zone-reviewer', verdict: 'APPROVED', findings: [], unresolvedBlockers: [], raw: '' },
    ]
    const gate = evaluatePlanReviewGate(results)
    expect(gate.ok).toBe(true)
    expect(gate.importantFindings).toHaveLength(1)
    expect(hasImportantOrCriticalFindings(results, gate.importantFindings)).toBe(true)
    expect(planReviewStopAdvice({ cycle: 1, gateOk: gate.ok, hasImportantOrCritical: true })).toBe('CONTINUE')
    expect(planReviewStopAdvice({ cycle: 2, gateOk: gate.ok, hasImportantOrCritical: true })).toBe('STOP_SHOW_USER')
  })

  it('runs required reviewers through pi json mode and parses assistant output', async () => {
    const calls: Array<{ command: string, args: string[] }> = []
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args })
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'PLAN REVIEW: APPROVED\nFindings:\n- severity: minor\n  issue: none\n  evidence: reviewed plan\n  suggested fix: none\nUnresolved blockers: none' }],
            },
          }) + '\n',
        }
      },
    }

    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', ['plan-edge-reviewer'])

    expect(calls[0]).toMatchObject({ command: 'pi' })
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      '--mode', 'json',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--tools', 'read,grep,find,ls',
      '--append-system-prompt', '/repo/.pi/agents/plan-edge-reviewer.md',
    ]))
    expect(calls[0]?.args).not.toEqual(expect.arrayContaining(['edit', 'write', 'bash']))
    expect(results[0]).toMatchObject({ reviewer: 'plan-edge-reviewer', verdict: 'APPROVED' })
  })
})
