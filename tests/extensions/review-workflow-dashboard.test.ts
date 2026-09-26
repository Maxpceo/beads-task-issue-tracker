import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import reviewWorkflowExtension, { setSpawnForReviewTestOverride } from '../../.pi/extensions/review-workflow/index'
import { clearObservedDashboardCards, createDashboardState, getSharedDashboardState, registerDashboardRenderer, selectDashboardAgents, setSharedDashboardState } from '../../.pi/extensions/subagent/dashboard'

function createApprovedReviewerSpawn() {
  return (() => {
    const proc: any = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => true
    queueMicrotask(() => {
      proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'CODE REVIEW: APPROVED\nEvidence: test reviewer approved.' }] } }) + '\n')
      proc.stdout.end()
      proc.stderr.end()
      proc.emit('close', 0)
    })
    return proc
  }) as any
}

let unregisterRenderer: (() => void) | undefined

beforeEach(() => {
  setSpawnForReviewTestOverride(null)
  unregisterRenderer?.()
  unregisterRenderer = undefined
  clearObservedDashboardCards()
  setSharedDashboardState(null)
})

afterEach(() => {
  setSpawnForReviewTestOverride(null)
  unregisterRenderer?.()
  clearObservedDashboardCards()
  setSharedDashboardState(null)
})

describe('review workflow dashboard publishing', () => {
  it('publishes code-reviewer completion through registered review_bead and requests repaint', async () => {
    let registeredTool: any
    let repaintCount = 0
    const execCalls: Array<{ command: string; args: string[] }> = []
    const cwd = process.cwd()
    const branch = 'fix/dashboard-review'
    const startCommit = 'abc1234'
    const endCommit = 'def5678'
    const comments = `DISPATCH RESULT (test-supervisor)\n\nSTART_COMMIT: ${startCommit}\n\nSUPERVISOR ARTIFACT:\nArtifact status: complete\nVerification: pnpm test -> exit 0`
    const state = createDashboardState(selectDashboardAgents([{ name: 'code-reviewer', description: 'Review code', source: 'project' }], { teams: [], warnings: [] }), 'active')
    setSharedDashboardState(state)
    unregisterRenderer = registerDashboardRenderer({ requestRender: () => repaintCount++ })
    setSpawnForReviewTestOverride(createApprovedReviewerSpawn())
    const pi = {
      events: { emit() {} },
      registerCommand() {},
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-review', status: 'inreview', labels: ['pi'], description: '' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args.length === 2) return { stdout: comments, stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'update') return { stdout: '', stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'close') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('--show-toplevel')) return { stdout: `${cwd}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('diff')) return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-review', startCommit, endCommit, worktreePath: cwd, dryRun: false }, undefined, undefined, { cwd })

    const matrixCall = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))
    const matrix = String(matrixCall?.args[3] ?? '')

    expect(result.details.error).toBeUndefined()
    expect(result.details.reviewerExitCode).toBe(0)
    expect(matrix).toContain('| review_bead approved-path acceptance | N/A: no explicit acceptance/verification bullets found and no required verification is applicable; CODE REVIEW: APPROVED; automated check summary: No automated checks selected for changed files. | N/A |')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.join(' ').includes('--status accepted'))).toBe(true)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close' && call.args[1] === 'bead-review')).toBe(true)
    expect(getSharedDashboardState()?.cards.get('code-reviewer')?.status).toBe('completed')
    expect(repaintCount).toBeGreaterThan(0)
  })
})
