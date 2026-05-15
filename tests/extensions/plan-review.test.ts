import { describe, expect, it } from 'vitest'

import planReviewExtension, {
  evaluatePlanReviewGate,
  missingRevisedPlanSections,
  parsePlanReviewOutput,
  runPlanReviewers,
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
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--mode', 'json', '--append-system-prompt', '/repo/.pi/agents/plan-edge-reviewer.md']))
    expect(results[0]).toMatchObject({ reviewer: 'plan-edge-reviewer', verdict: 'APPROVED' })
  })
})
