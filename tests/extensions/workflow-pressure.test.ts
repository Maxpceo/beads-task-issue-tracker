import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { evaluateBashPolicy } from '../../.pi/extensions/beads-policy/index'
import { validateSupervisorReadiness } from '../../.pi/extensions/beads-dispatch/index'
import reviewWorkflowExtension from '../../.pi/extensions/review-workflow/index'

const handoffDescription = `### Origin
- Pressure-test fixture.
### Files
- tests/extensions/workflow-pressure.test.ts
### Current state
- Guardrail behavior needs a stable safety net.
### Target state
- Guardrail behavior is blocked or allowed deterministically.
### Investigation findings
- Existing focused extension tests cover implementation details.
### Decisions
- Keep this fixture on stable cross-workflow invariants.
### Rejected alternatives
- Duplicate unresolved bug beads.
### Dependencies / blockers
- none.
### Acceptance criteria
- Dispatch is blocked until there is approved plan evidence.
### Verification / acceptance checks
- Vitest verifies the guardrail result.
### Out of scope
- Runtime supervisor dispatch.`

function registerReviewTool(piOverrides: Record<string, unknown>) {
  let registeredTool: any
  const pi = { events: { emit() {} }, registerCommand() {}, ...piOverrides,
    registerTool(tool: any) { if (tool.name === 'review_bead') registeredTool = tool },
  }
  reviewWorkflowExtension(pi as any)
  return registeredTool
}

describe('Pi workflow pressure guardrails', () => {
  it('pressure guardrail: policy blocks dangerous recursive force delete before shell execution', () => {
    const decision = evaluateBashPolicy('rm -rf ./dist-cache', { state: 'implementing' }, { cwd: tmpdir() })
    expect(decision).toMatchObject({ policy: 'blockDestructiveCommand', block: true })
    expect(decision?.reason).toContain('recursive force delete')
  })

  it('pressure guardrail: dispatch readiness blocks supervisor handoff without approved plan evidence', () => {
    const errors = validateSupervisorReadiness({ id: 'bead-pressure', status: 'in_progress', labels: ['pi', 'workflow'], description: handoffDescription }, [])
    expect(errors.some((error) => error.includes('PLAN APPROVED'))).toBe(true)
    expect(errors.some((error) => error.includes('в PLAN APPROVED comment отсутствуют fields:'))).toBe(true)
    expect(errors).not.toContain(expect.stringContaining('Acceptance criteria должны содержать'))
  })

  it('pressure guardrail: review_bead refuses non-inreview beads before running review checks', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const registeredTool = registerReviewTool({ exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-pressure', status: 'in_progress' }), stderr: '', code: 0 }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    } })
    const result = await registeredTool.execute('call-1', { beadId: 'bead-pressure', dryRun: true }, undefined, undefined, { cwd: '/repo/task' })
    expect(result.details.error).toBe('review_bead требует status inreview, получен in_progress')
    expect(execCalls).toEqual([{ command: 'bd', args: ['show', 'bead-pressure', '--json'] }])
  })

  it('pressure guardrail: review_bead requires current branch/worktree/start ownership evidence', async () => {
    const registeredTool = registerReviewTool({ exec: async (command: string, args: string[]) => {
      if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-pressure', status: 'inreview' }), stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments') return { stdout: 'PLAN APPROVED\nSTART_COMMIT: aaa1111\nBRANCH: task/other\nWORKTREE: /repo/other', stderr: '', code: 0 }
      if (command === 'git' && args.join(' ') === '-C /repo/task branch --show-current') return { stdout: 'task/current\n', stderr: '', code: 0 }
      if (command === 'git' && args.join(' ') === '-C /repo/task rev-parse --show-toplevel') return { stdout: '/repo/task\n', stderr: '', code: 0 }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    } })
    const result = await registeredTool.execute('call-1', { beadId: 'bead-pressure', startCommit: 'aaa1111', worktreePath: '/repo/task', dryRun: true }, undefined, undefined, { cwd: '/repo/main' })
    expect(result.details.error).toContain('нет совпадающего branch/worktree/start ownership evidence')
    expect(result.details.error).toContain('/repo/task')
  })
})
