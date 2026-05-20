import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import reviewWorkflowExtension, { isReviewApproved } from '../../.pi/extensions/review-workflow/index'

describe('review_workflow scoped review', () => {
  it('uses endCommit for stacked branch diff scope in dryRun', async () => {
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const pi = {
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') return { stdout: 'DISPATCH\n\nBRANCH: feature/test\nWORKTREE: /repo/current\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: 'feature/test\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ').includes('rev-parse --show-toplevel')) return { stdout: '/repo/current\n', stderr: '', code: 0 }
        if (command === 'git' && args.includes('diff')) return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true }, undefined, undefined, { cwd: process.cwd() })

    expect(execCalls).toContainEqual({ command: 'git', args: ['-C', process.cwd(), 'diff', '--name-only', 'aaa1111..bbb2222'] })
    expect(result.details.endCommit).toBe('bbb2222')
    expect(result.content[0].text).toContain('diff=aaa1111..bbb2222')
  })

  it('includes matching path rules in review dryRun context', async () => {
    let registeredTool: any
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') return { stdout: 'DISPATCH\n\nBRANCH: feature/test\nWORKTREE: /repo/current\nSTART_COMMIT: aaa1111', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: 'feature/test\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ').includes('rev-parse --show-toplevel')) return { stdout: '/repo/current\n', stderr: '', code: 0 }
        if (command === 'git' && args.includes('diff')) return { stdout: 'src-tauri/src/lib.rs\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true }, undefined, undefined, { cwd: process.cwd() })

    expect(result.content[0].text).toContain('PATH_RULES_LOADED:')
    expect(result.content[0].text).toContain('--- src-tauri/CLAUDE.md')
    expect(result.details.pathRulesLoaded).toContain('# src-tauri/ — Rust backend')
  })


  it('accepts explicit task worktree dispatch evidence from a main-session orchestrator', async () => {
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') {
          return { stdout: 'DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: /repo/worktrees/bead-a\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222', stderr: '', code: 0 }
        }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a branch --show-current') return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a rev-parse --show-toplevel') return { stdout: '/repo/worktrees/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a diff --name-only aaa1111..bbb2222') return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: '/repo/worktrees/bead-a', dryRun: true }, undefined, undefined, { cwd: '/repo/main' })

    expect(execCalls).toContainEqual({ command: 'git', args: ['-C', '/repo/worktrees/bead-a', 'diff', '--name-only', 'aaa1111..bbb2222'] })
    expect(result.content[0].text).toContain('branch=task/bead-a')
    expect(result.content[0].text).toContain('diff=aaa1111..bbb2222')
    expect(result.details.error).toBeUndefined()
  })

  it('runs non-dry automated checks in explicit task worktree before reviewer dispatch', async () => {
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') {
          return { stdout: 'DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: /repo/worktrees/bead-a\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222', stderr: '', code: 0 }
        }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a branch --show-current') return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a rev-parse --show-toplevel') return { stdout: '/repo/worktrees/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a diff --name-only aaa1111..bbb2222') return { stdout: 'tests/extensions/review-workflow.test.ts\n', stderr: '', code: 0 }
        if (command === 'pnpm' && args.join(' ') === '--dir /repo/worktrees/bead-a test') return { stdout: 'tests passed\n', stderr: '', code: 0 }
        if (command === 'npx' && args.join(' ') === '--prefix /repo/worktrees/bead-a vue-tsc --noEmit') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: '/repo/worktrees/bead-a' }, undefined, undefined, { cwd: '/repo/main' })

    expect(execCalls).toContainEqual({ command: 'pnpm', args: ['--dir', '/repo/worktrees/bead-a', 'test'] })
    expect(execCalls).toContainEqual({ command: 'npx', args: ['--prefix', '/repo/worktrees/bead-a', 'vue-tsc', '--noEmit'] })
    expect(result.content[0].text).toContain('Отсутствует .pi/agents/code-reviewer.md')
  })

  it('refuses task worktree review when branch and worktree match but start commit is stale', async () => {
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const pi = {
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') {
          return { stdout: 'DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: /repo/worktrees/bead-a\nSTART_COMMIT: old1111\nEND_COMMIT: bbb2222', stderr: '', code: 0 }
        }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a branch --show-current') return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a rev-parse --show-toplevel') return { stdout: '/repo/worktrees/bead-a\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: '/repo/worktrees/bead-a', startCommit: 'new2222', endCommit: 'bbb2222', dryRun: true }, undefined, undefined, { cwd: '/repo/main' })

    expect(result.content[0].text).toContain('нет совпадающего branch/worktree/start ownership evidence')
    expect(execCalls).not.toContainEqual({ command: 'git', args: ['-C', '/repo/worktrees/bead-a', 'diff', '--name-only', 'new2222..bbb2222'] })
  })

  it('refuses dryRun review without current-session ownership evidence', async () => {
    let registeredTool: any
    const pi = {
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') return { stdout: 'DISPATCH\n\nBRANCH: feature/other\nWORKTREE: /repo/other\nSTART_COMMIT: aaa1111', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: 'feature/test\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ').includes('rev-parse --show-toplevel')) return { stdout: '/repo/current\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true }, undefined, undefined, { cwd: process.cwd() })

    expect(result.content[0].text).toContain('нет совпадающего branch/worktree/start ownership evidence')
    expect(result.content[0].text).toContain('workflow_reset')
  })

  it('refuses dryRun review when old current ownership is followed by later foreign takeover evidence', async () => {
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const pi = {
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') {
          return {
            stdout: 'DISPATCH\n\nBRANCH: feature/test\nWORKTREE: /repo/current\nSTART_COMMIT: aaa1111\n\nREDISPATCH\n\nBRANCH: feature/other\nWORKTREE: /repo/other',
            stderr: '',
            code: 0,
          }
        }
        if (command === 'git' && args.includes('branch')) return { stdout: 'feature/test\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ').includes('rev-parse --show-toplevel')) return { stdout: '/repo/current\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true }, undefined, undefined, { cwd: process.cwd() })

    expect(result.content[0].text).toContain('нет совпадающего branch/worktree/start ownership evidence')
    expect(result.content[0].text).toContain('workflow_reset')
    expect(result.content[0].text).toContain('подтвердить takeover')
    expect(execCalls).not.toContainEqual({ command: 'git', args: ['diff', '--name-only', 'aaa1111..HEAD'] })
  })
})

describe('review_workflow reviewer verdict handling', () => {
  function createFakeReviewerWorktree(reviewerOutput: string): { cwd: string; binDir: string; cleanup: () => void } {
    const cwd = mkdtempSync(join(tmpdir(), 'review-workflow-cwd-'))
    const binDir = mkdtempSync(join(tmpdir(), 'review-workflow-bin-'))
    mkdirSync(join(cwd, '.pi', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'agents', 'code-reviewer.md'), '---\nmodel: test\n---\nReview fixture')
    writeFileSync(join(binDir, 'pi'), `#!/usr/bin/env bash\ncat <<'PI_REVIEW_OUTPUT'\n${reviewerOutput}\nPI_REVIEW_OUTPUT\n`)
    chmodSync(join(binDir, 'pi'), 0o755)
    return {
      cwd,
      binDir,
      cleanup: () => {
        rmSync(cwd, { recursive: true, force: true })
        rmSync(binDir, { recursive: true, force: true })
      },
    }
  }

  async function runNonDryReview(reviewerOutput: string, options: { failRestore?: boolean } = {}) {
    const fixture = createFakeReviewerWorktree(reviewerOutput)
    const oldPath = process.env.PATH
    const oldArgv1 = process.argv[1] ?? ''
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const workflowEvents: Array<Record<string, unknown>> = []
    const pi = {
      events: { emit(_name: string, event: Record<string, unknown>) { workflowEvents.push(event) } },
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') {
          return { stdout: `DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: ${fixture.cwd}\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222`, stderr: '', code: 0 }
        }
        if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} branch --show-current`) return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} rev-parse --show-toplevel`) return { stdout: `${fixture.cwd}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} diff --name-only aaa1111..bbb2222`) return { stdout: 'tests/extensions/review-workflow.test.ts\n', stderr: '', code: 0 }
        if (command === 'pnpm' && args.join(' ') === `--dir ${fixture.cwd} test`) return { stdout: 'tests passed\n', stderr: '', code: 0 }
        if (command === 'npx' && args.join(' ') === `--prefix ${fixture.cwd} vue-tsc --noEmit`) return { stdout: '', stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'update' && args[1] === 'bead-a' && args.join(' ').includes('--status inreview') && options.failRestore) {
          return { stdout: '', stderr: 'restore denied', code: 1 }
        }
        if (command === 'bd') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    try {
      process.env.PATH = `${fixture.binDir}${delimiter}${oldPath ?? ''}`
      process.argv[1] = join(fixture.cwd, 'missing-pi-entrypoint.js')
      reviewWorkflowExtension(pi as any)
      const result = await registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: fixture.cwd }, undefined, undefined, { cwd: fixture.cwd })
      return { result, execCalls, workflowEvents }
    } finally {
      process.env.PATH = oldPath
      process.argv[1] = oldArgv1
      fixture.cleanup()
    }
  }

  it.each([
    'VERDICT: NOT_APPROVED',
    'VERDICT: NOT APPROVED',
    'CODE REVIEW: NOT_APPROVED',
    'CODE REVIEW: NOT APPROVED',
  ])('does not treat %s as an approved review', (output) => {
    expect(isReviewApproved(output)).toBe(false)
  })

  it('matches exact approved review markers only', () => {
    expect(isReviewApproved('VERDICT: APPROVED')).toBe(true)
    expect(isReviewApproved('CODE REVIEW: APPROVED')).toBe(true)
    expect(isReviewApproved('prefix CODE REVIEW: APPROVED')).toBe(false)
  })

  it('restores inreview after reviewer returns NOT_APPROVED and preserves reviewer output', async () => {
    const { result, execCalls, workflowEvents } = await runNonDryReview('VERDICT: NOT_APPROVED\nFix required')
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add').map((call) => call.args.join(' '))

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status inreview'])
    expect(statusUpdates.some((args) => args.includes('--status reviewed') || args.includes('--status accepted') || args.includes('--status closed'))).toBe(false)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(comments.some((args) => args.includes('CODE REVIEW: NOT APPROVED'))).toBe(true)
    expect(result.details.reviewerOutput).toContain('VERDICT: NOT_APPROVED')
    expect(result.content[0].text).toContain('reviewerOutput:')
    expect(workflowEvents.at(-1)).toMatchObject({ sessionMode: 'inreview' })
  })

  it('reports an error when NOT_APPROVED restore to inreview fails', async () => {
    const { result, execCalls } = await runNonDryReview('CODE REVIEW: NOT APPROVED\nFix required', { failRestore: true })
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status inreview'])
    expect(result.content[0].text).toContain('review_bead не выполнен')
    expect(result.content[0].text).toContain('restore denied')
    expect(result.details.error).toContain('restore denied')
  })

  it('keeps exact APPROVED path moving reviewed to accepted and close', async () => {
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady')
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status reviewed', 'update bead-a --status accepted'])
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close' && call.args[1] === 'bead-a')).toBe(true)
    expect(result.details.error).toBeUndefined()
  })
})
