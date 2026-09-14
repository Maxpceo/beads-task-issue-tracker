import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import reviewWorkflowExtension, {
  isReviewApproved,
  setReviewRuntimeDelegateForTestOverride,
  setSpawnForReviewTestOverride,
} from '../../.pi/extensions/review-workflow/index'

afterEach(() => {
  setSpawnForReviewTestOverride(null)
  setReviewRuntimeDelegateForTestOverride(null)
})

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


  it('routes review_bead from main-start context to structured task worktree without explicit worktreePath', async () => {
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const taskWorktree = mkdtempSync(join(tmpdir(), 'review-task-worktree-'))
    const mainCwd = dirname(taskWorktree)
    const branch = 'task/current'
    execFileSync('git', ['init', '-b', branch, taskWorktree], { stdio: 'ignore' })
    try {
      const pi = {
        events: { emit() {} },
        registerTool(tool: any) {
          if (tool.name === 'review_bead') registeredTool = tool
        },
        registerCommand() {},
        exec: async (command: string, args: string[]) => {
          execCalls.push({ command, args })
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments') return { stdout: `DISPATCH RESULT (test-supervisor)\n\nBRANCH: ${branch}\nWORKTREE: ${taskWorktree}\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222`, stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${mainCwd} branch --show-current`) return { stdout: 'main\n', stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${mainCwd} rev-parse --show-toplevel`) return { stdout: `${mainCwd}\n`, stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${taskWorktree} branch --show-current`) return { stdout: `${branch}\n`, stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${taskWorktree} rev-parse --show-toplevel`) return { stdout: `${taskWorktree}\n`, stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${taskWorktree} diff --name-only aaa1111..bbb2222`) return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 0 }
        },
      }

      reviewWorkflowExtension(pi as any)
      const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true }, undefined, undefined, {
        cwd: mainCwd,
        sessionManager: {
          getEntries: () => [{ type: 'custom', customType: 'workflow-state', data: { activeBead: 'bead-a', branch, worktreePath: taskWorktree, startCommit: 'aaa1111', endCommit: 'bbb2222', sessionKey: 'session:test' } }],
        },
      })

      expect(execCalls).toContainEqual({ command: 'git', args: ['-C', taskWorktree, 'diff', '--name-only', 'aaa1111..bbb2222'] })
      expect(result.details.worktreePath).toBe(taskWorktree)
    } finally {
      rmSync(taskWorktree, { recursive: true, force: true })
    }
  })

  it('accepts PI WORKFLOW UPDATE ownership evidence without splitting on dispatch branch names', async () => {
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const worktree = '/repo/worktrees/wa52-agents-dashboard-dispatch'
    const branch = 'fix/wa52-agents-dashboard-dispatch'
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
          return {
            stdout: [
              'PLAN APPROVED continuation completed: dispatch_supervisor(beadId=bead-a)',
              '',
              'PI WORKFLOW UPDATE',
              '',
              `BRANCH: ${branch}`,
              `WORKTREE: ${worktree}`,
              'START_COMMIT: aaa1111',
              'END_COMMIT: bbb2222',
              'SESSION_MODE: reviewing',
            ].join('\n'),
            stderr: '',
            code: 0,
          }
        }
        if (command === 'git' && args.join(' ') === `-C ${worktree} branch --show-current`) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${worktree} rev-parse --show-toplevel`) return { stdout: `${worktree}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${worktree} diff --name-only aaa1111..bbb2222`) return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: worktree, dryRun: true }, undefined, undefined, { cwd: '/repo/main' })

    expect(execCalls).toContainEqual({ command: 'git', args: ['-C', worktree, 'diff', '--name-only', 'aaa1111..bbb2222'] })
    expect(result.details.error).toBeUndefined()
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

  it('accepts matching DISPATCH RESULT ownership with workflow-like body lines', async () => {
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
          return {
            stdout: 'DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: /repo/worktrees/bead-a\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222\n\ndispatch_supervisor returned DONE\nPLAN APPROVED continuation remains body text\nPI WORKFLOW notes remain body text',
            stderr: '',
            code: 0,
          }
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
    expect(result.content[0].text).toContain('diff=aaa1111..bbb2222')
    expect(result.details.error).toBeUndefined()
  })

  it('accepts matching PI WORKFLOW UPDATE ownership with workflow-like body lines', async () => {
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
          return {
            stdout: 'PI WORKFLOW UPDATE\n\nBRANCH: task/bead-a\nWORKTREE: /repo/worktrees/bead-a\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222\n\ndispatch_supervisor follow-up note\nPLAN APPROVED continuation remains body text\nPI WORKFLOW notes remain body text',
            stderr: '',
            code: 0,
          }
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
    expect(result.content[0].text).toContain('diff=aaa1111..bbb2222')
    expect(result.details.error).toBeUndefined()
  })

  it('renders accepted SUPERVISOR ARTIFACT evidence in review dryRun context', async () => {
    let registeredTool: any
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments') {
          return {
            stdout: 'DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: /repo/worktrees/bead-a\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222\n\nSUPERVISOR ARTIFACT\nStatus: DONE\nFiles changed: tests/extensions/review-workflow.test.ts\nVerification: pnpm test -- tests/extensions/review-workflow.test.ts\nExit code: 0\nArtifact status: accepted',
            stderr: '',
            code: 0,
          }
        }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a branch --show-current') return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a rev-parse --show-toplevel') return { stdout: '/repo/worktrees/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a diff --name-only aaa1111..bbb2222') return { stdout: 'tests/extensions/review-workflow.test.ts\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: '/repo/worktrees/bead-a', dryRun: true }, undefined, undefined, { cwd: '/repo/main' })

    expect(result.content[0].text).toContain('SUPERVISOR ARTIFACT:')
    expect(result.content[0].text).toContain('ARTIFACT STATUS: accepted')
    expect(result.content[0].text).toContain('Artifact status: accepted')
    expect(result.content[0].text).toContain('artifact evidence may be cited in acceptance matrix, but it is not acceptance by itself')
    expect(result.details.supervisorArtifact.status).toBe('accepted')
  })

  it('renders missing and insufficient SUPERVISOR ARTIFACT status in review handoff', async () => {
    async function runWithComments(comments: string) {
      let registeredTool: any
      const pi = {
        events: { emit() {} },
        registerTool(tool: any) {
          if (tool.name === 'review_bead') registeredTool = tool
        },
        registerCommand() {},
        exec: async (command: string, args: string[]) => {
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments') return { stdout: comments, stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a branch --show-current') return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a rev-parse --show-toplevel') return { stdout: '/repo/worktrees/bead-a\n', stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a diff --name-only aaa1111..bbb2222') return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 0 }
        },
      }
      reviewWorkflowExtension(pi as any)
      return registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: '/repo/worktrees/bead-a', dryRun: true }, undefined, undefined, { cwd: '/repo/main' })
    }

    const base = 'DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: /repo/worktrees/bead-a\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222'
    const missing = await runWithComments(base)
    const insufficient = await runWithComments(`${base}\n\nSUPERVISOR ARTIFACT\nStatus: DONE\nVerification: not run\nArtifact status: insufficient`)
    const doneWithoutEvidence = await runWithComments(`${base}\n\nSUPERVISOR ARTIFACT\nStatus: DONE\nVerification: not run`)

    expect(missing.content[0].text).toContain('ARTIFACT STATUS: N/A')
    expect(missing.details.supervisorArtifact.status).toBe('n/a')
    expect(insufficient.content[0].text).toContain('ARTIFACT STATUS: insufficient')
    expect(insufficient.details.supervisorArtifact.status).toBe('insufficient')
    expect(doneWithoutEvidence.content[0].text).toContain('ARTIFACT STATUS: missing')
    expect(doneWithoutEvidence.details.supervisorArtifact.status).toBe('missing')
  })

  it('accepts workflow_submit_for_review durable task worktree evidence from a main-session orchestrator', async () => {
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
          return { stdout: 'WORKFLOW SUBMIT FOR REVIEW\n\nBRANCH: task/bead-a\nWORKTREE: /repo/worktrees/bead-a\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222\nPI_SESSION_KEY: id:session-current\n\ntests passed', stderr: '', code: 0 }
        }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a branch --show-current') return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a rev-parse --show-toplevel') return { stdout: '/repo/worktrees/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === '-C /repo/worktrees/bead-a diff --name-only aaa1111..bbb2222') return { stdout: 'tests/extensions/workflow-state.test.ts\n', stderr: '', code: 0 }
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

  async function runNonDryReview(reviewerOutput: string, options: { failRestore?: boolean; failMatrixWrite?: boolean; failPnpm?: boolean; skipChecks?: boolean; beadDescription?: string; changedFiles?: string; reviewWorkflowRuntimeSource?: string; supervisorComments?: string } = {}) {
    const fixture = createFakeReviewerWorktree(reviewerOutput)
    if (options.reviewWorkflowRuntimeSource !== undefined) {
      mkdirSync(join(fixture.cwd, '.pi', 'extensions', 'review-workflow'), { recursive: true })
      writeFileSync(join(fixture.cwd, '.pi', 'extensions', 'review-workflow', 'index.ts'), options.reviewWorkflowRuntimeSource)
    }
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
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview', description: options.beadDescription ?? '### Acceptance criteria\n- Approved review closes only after durable matrix.\n### Verification / acceptance checks\n- pnpm --dir <worktree> test\n- npx --prefix <worktree> vue-tsc --noEmit' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') {
          return { stdout: (options.supervisorComments?.replaceAll('__WORKTREE__', fixture.cwd)) ?? `DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: ${fixture.cwd}\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222`, stderr: '', code: 0 }
        }
        if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} branch --show-current`) return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} rev-parse --show-toplevel`) return { stdout: `${fixture.cwd}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} diff --name-only aaa1111..bbb2222`) return { stdout: `${options.changedFiles ?? (options.skipChecks ? 'README.md' : 'tests/extensions/review-workflow.test.ts')}\n`, stderr: '', code: 0 }
        if (command === 'pnpm' && args.join(' ') === `--dir ${fixture.cwd} test`) return options.failPnpm ? { stdout: '', stderr: 'tests failed\n', code: 1 } : { stdout: 'tests passed\n', stderr: '', code: 0 }
        if (command === 'npx' && args.join(' ') === `--prefix ${fixture.cwd} vue-tsc --noEmit`) return { stdout: '', stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'update' && args[1] === 'bead-a' && args.join(' ').includes('--status inreview') && options.failRestore) {
          return { stdout: '', stderr: 'restore denied', code: 1 }
        }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add' && args.some((arg) => String(arg).startsWith('ACCEPTANCE MATRIX:')) && options.failMatrixWrite) {
          return { stdout: '', stderr: 'matrix write denied', code: 1 }
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
    expect(isReviewApproved('- CODE REVIEW: APPROVED')).toBe(true)
    expect(isReviewApproved('prefix CODE REVIEW: APPROVED')).toBe(false)
  })

  it('uses final assistant verdict from JSONL transcript with nested content blocks', () => {
    const output = [
      { type: 'tool_result_end', message: { role: 'tool', content: [{ type: 'text', text: 'CODE REVIEW: NOT APPROVED\nintermediate wrapper' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'CODE REVIEW: APPROVED\nVERDICT: APPROVED' }] } },
    ].map((record) => JSON.stringify(record)).join('\n')

    expect(isReviewApproved(output)).toBe(true)
  })

  it('uses the latest adjacent assistant verdict marker', () => {
    expect(isReviewApproved(JSON.stringify({ role: 'assistant', content: 'CODE REVIEW: APPROVED\nVERDICT: NOT_APPROVED' }))).toBe(false)
    expect(isReviewApproved(JSON.stringify({ role: 'assistant', content: 'CODE REVIEW: NOT APPROVED\nVERDICT: APPROVED' }))).toBe(true)
  })

  it('uses Pi final-answer text records as authoritative reviewer output', () => {
    const textSignature = JSON.stringify({ v: 1, phase: 'final_answer' })
    const output = JSON.stringify([
      { type: 'toolResult', content: [{ type: 'text', text: 'CODE REVIEW: NOT APPROVED\nintermediate tool output' }] },
      { type: 'text', text: 'CODE REVIEW: APPROVED\nVERDICT: APPROVED', textSignature },
    ])

    expect(isReviewApproved(output)).toBe(true)
  })

  it('uses nested Pi final-answer text blocks from non-tool wrappers as authoritative reviewer output', () => {
    const output = JSON.stringify([
      { type: 'tool_result_end', message: { role: 'tool', content: [{ type: 'text', text: 'CODE REVIEW: NOT APPROVED\nintermediate tool output' }] } },
      {
        type: 'message_update',
        output: [
          { type: 'thinking_delta', text: 'internal reasoning without verdict' },
          { type: 'text', text: 'CODE REVIEW: APPROVED\nVERDICT: APPROVED', textSignature: { v: 1, phase: 'final_answer' } },
        ],
      },
    ])

    expect(isReviewApproved(output)).toBe(true)
  })

  it('uses assistant message_update content when final text is surrounded by encrypted/thinking/tool noise', () => {
    const output = JSON.stringify([
      { type: 'tool_result_end', message: { role: 'tool', content: [{ type: 'text', text: 'CODE REVIEW: NOT APPROVED\nintermediate tool output' }] } },
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'encrypted_thinking', text: 'opaque transcript chunk with CODE REVIEW: NOT APPROVED' },
            { type: 'thinking_delta', text: 'reasoning with VERDICT: NOT APPROVED' },
            { type: 'text', text: 'CODE REVIEW: APPROVED\nVERDICT: APPROVED' },
          ],
        },
      },
    ])

    expect(isReviewApproved(output)).toBe(true)
  })

  it('ignores signed-looking final-answer text nested under tool or log records', () => {
    const output = JSON.stringify([
      { type: 'toolResult', content: [{ type: 'text', text: 'CODE REVIEW: APPROVED', textSignature: { phase: 'final_answer' } }] },
      { type: 'log', output: [{ type: 'text', text: 'VERDICT: APPROVED', textSignature: { phase: 'final_answer' } }] },
    ])

    expect(isReviewApproved(output)).toBe(false)
  })

  it('uses the latest verdict from the global authoritative structured stream', () => {
    const earlierApprovedLaterRejected = JSON.stringify([
      { type: 'message_update', output: [{ type: 'text', text: 'CODE REVIEW: APPROVED\nVERDICT: APPROVED', textSignature: { phase: 'final_answer' } }] },
      { type: 'message_update', output: [{ type: 'text', text: 'CODE REVIEW: NOT APPROVED\nVERDICT: NOT APPROVED', textSignature: { phase: 'final_answer' } }] },
    ])
    const assistantRejectedLaterSignedApproved = JSON.stringify([
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'CODE REVIEW: NOT APPROVED\nVERDICT: NOT APPROVED' }] } },
      { type: 'message_update', output: [{ type: 'text', text: 'CODE REVIEW: APPROVED\nVERDICT: APPROVED', textSignature: { phase: 'final_answer' } }] },
    ])

    expect(isReviewApproved(earlierApprovedLaterRejected)).toBe(false)
    expect(isReviewApproved(assistantRejectedLaterSignedApproved)).toBe(true)
  })

  it('does not fall back to tool/log approval when structured final verdict is not approved or missing', () => {
    const toolApprovedAssistantRejected = [
      { type: 'tool_result_end', message: { role: 'tool', content: [{ type: 'text', text: 'CODE REVIEW: APPROVED' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'CODE REVIEW: NOT APPROVED\nVERDICT: NOT_APPROVED' }] } },
    ].map((record) => JSON.stringify(record)).join('\n')
    const toolApprovedNoAssistant = JSON.stringify({ type: 'tool_result_end', message: { role: 'tool', content: [{ type: 'text', text: 'CODE REVIEW: APPROVED' }] } })

    expect(isReviewApproved(toolApprovedAssistantRejected)).toBe(false)
    expect(isReviewApproved(toolApprovedNoAssistant)).toBe(false)
  })

  it('records APPROVED when main-start parent receives task-worktree JSONL final assistant verdict', async () => {
    const output = [
      { type: 'tool_result_end', message: { role: 'tool', content: [{ type: 'text', text: 'CODE REVIEW: NOT APPROVED\nintermediate wrapper' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'CODE REVIEW: APPROVED\nVERDICT: APPROVED' }] } },
    ].map((record) => JSON.stringify(record)).join('\n')
    const { result, execCalls } = await runNonDryReview(output)
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add').map((call) => call.args.join(' '))

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status reviewed', 'update bead-a --status accepted'])
    expect(comments.some((args) => args.includes('CODE REVIEW: APPROVED'))).toBe(true)
    expect(comments.some((args) => args.includes('CODE REVIEW: NOT APPROVED'))).toBe(false)
    expect(comments.some((args) => args.includes('ARTIFACT STATUS: N/A'))).toBe(true)
    expect(execCalls.some((call) => call.command === 'git' && call.args[0] === '-C' && call.args[1]?.includes('review-workflow-cwd-') === true && call.args.slice(2).join(' ') === 'diff --name-only aaa1111..bbb2222')).toBe(true)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close' && call.args[1] === 'bead-a')).toBe(true)
    expect(result.details.error).toBeUndefined()
  })

  it('records NOT APPROVED when structured transcript has only tool approval', async () => {
    const output = JSON.stringify({ type: 'tool_result_end', message: { role: 'tool', content: [{ type: 'text', text: 'CODE REVIEW: APPROVED' }] } })
    const { result, execCalls, workflowEvents } = await runNonDryReview(output)
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add').map((call) => call.args.join(' '))

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status inreview'])
    expect(comments.some((args) => args.includes('CODE REVIEW: NOT APPROVED'))).toBe(true)
    expect(result.details.reviewerOutput).toContain('CODE REVIEW: APPROVED')
    expect(workflowEvents.at(-1)).toMatchObject({ sessionMode: 'inreview' })
  })

  it('restores inreview after reviewer returns NOT_APPROVED and preserves reviewer output', async () => {
    const { result, execCalls, workflowEvents } = await runNonDryReview('VERDICT: NOT_APPROVED\nFix required')
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add').map((call) => call.args.join(' '))

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status inreview'])
    expect(statusUpdates.some((args) => args.includes('--status reviewed') || args.includes('--status accepted') || args.includes('--status closed'))).toBe(false)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(comments.some((args) => args.includes('CODE REVIEW: NOT APPROVED'))).toBe(true)
    expect(comments.some((args) => args.includes('ARTIFACT STATUS: N/A'))).toBe(true)
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

  it('keeps exact APPROVED path moving reviewed to accepted and close after ACCEPTANCE MATRIX is written', async () => {
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady')
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))
    const matrixIndex = execCalls.findIndex((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))
    const acceptedIndex = execCalls.findIndex((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.join(' ').includes('--status accepted'))
    const closeIndex = execCalls.findIndex((call) => call.command === 'bd' && call.args[0] === 'close' && call.args[1] === 'bead-a')

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status reviewed', 'update bead-a --status accepted'])
    expect(matrixIndex).toBeGreaterThan(-1)
    expect(matrixIndex).toBeLessThan(acceptedIndex)
    expect(matrixIndex).toBeLessThan(closeIndex)
    const matrixCall = execCalls[matrixIndex]
    expect(matrixCall).toBeDefined()
    expect(String(matrixCall?.args[3])).toContain('| Approved review closes only after durable matrix. |')
    expect(String(matrixCall?.args[3])).toContain('| PASS |')
    expect(result.details.error).toBeUndefined()
  })

  it('maps f7ra-like verification bullets to full passing test and vue-tsc evidence', async () => {
    const beadDescription = [
      '### Acceptance criteria',
      '- Existing approved path with successful matrix and PASS/no blocking rows still reaches accepted/closed flow.',
      '### Verification / acceptance checks',
      '- pnpm test tests/extensions/review-workflow.test.ts --reporter dot',
      '- npx vue-tsc --noEmit',
      '- Test assertions over execCalls prove matrix before accepted/close, matrix write failure avoids accepted/close, FAIL matrix is written then blocks accepted/close, and NOT RUN matrix is written then blocks accepted/close.',
    ].join('\n')
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { beadDescription })
    const matrixCall = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))
    const matrix = String(matrixCall?.args[3] ?? '')

    expect(matrixCall).toBeDefined()
    expect(matrix).toContain('| pnpm test tests/extensions/review-workflow.test.ts --reporter dot | command: pnpm --dir')
    expect(matrix).toContain('| npx vue-tsc --noEmit | command: npx --prefix')
    expect(matrix).toContain('| Test assertions over execCalls prove matrix before accepted/close')
    expect(matrix).not.toContain('| NOT RUN |')
    expect(matrix).toContain('All required acceptance rows are PASS or explicitly N/A.')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.join(' ').includes('--status accepted'))).toBe(true)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close' && call.args[1] === 'bead-a')).toBe(true)
    expect(result.details.error).toBeUndefined()
  })

  it('blocks accepted and close when ACCEPTANCE MATRIX comment write fails', async () => {
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { failMatrixWrite: true })
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status reviewed'])
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.join(' ').includes('--status accepted'))).toBe(false)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(result.content[0].text).toContain('matrix write denied')
    expect(result.details.error).toContain('matrix write denied')
  })

  it('writes FAIL matrix and blocks accepted and close when an executed check fails', async () => {
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { failPnpm: true })
    const matrixCall = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))

    expect(matrixCall).toBeDefined()
    expect(String(matrixCall?.args[3])).toContain('| FAIL |')
    expect(String(matrixCall?.args[3])).toContain('BLOCKER: acceptance matrix contains FAIL')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.join(' ').includes('--status accepted'))).toBe(false)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(result.details.error).toContain('ACCEPTANCE MATRIX contains blocking rows')
  })

  it('writes NOT RUN matrix and blocks accepted and close when required checks are skipped', async () => {
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { skipChecks: true })
    const matrixCall = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))

    expect(matrixCall).toBeDefined()
    expect(String(matrixCall?.args[3])).toContain('| NOT RUN |')
    expect(String(matrixCall?.args[3])).toContain('BLOCKER: acceptance matrix contains NOT RUN')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.join(' ').includes('--status accepted'))).toBe(false)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(result.details.error).toContain('ACCEPTANCE MATRIX contains blocking rows')
  })

  it('generates N/A only with explicit non-applicable context while required evidence remains PASS', async () => {
    const { execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady')
    const matrixCall = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))
    const matrix = String(matrixCall?.args[3] ?? '')

    expect(matrix).toContain('| Frontend review checklist | N/A: changed files (tests/extensions/review-workflow.test.ts) do not include app/*.vue UI changes. | N/A |')
    expect(matrix).toContain('| pnpm --dir <worktree> test | command: pnpm --dir')
    expect(matrix).toContain('| PASS |')
  })

  it('maps docs-only supervisor verification evidence to PASS and whitelisted conditional N/A', async () => {
    const beadDescription = [
      '### Acceptance criteria',
      '- review_bead preserves fail-closed acceptance policy.',
      '### Verification / acceptance checks',
      '- `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0.',
      '- Manual review confirms merge-to-main does not bypass accepted/close lifecycle.',
      '- If TypeScript extension code changes: `pnpm test tests/extensions/review-workflow.test.ts --reporter dot` exits 0.',
      '- If TypeScript extension code changes: `npx vue-tsc --noEmit` exits 0.',
    ].join('\n')
    const supervisorComments = [
      'DISPATCH RESULT (test-supervisor)',
      '',
      'BRANCH: task/bead-a',
      'WORKTREE: __WORKTREE__',
      'START_COMMIT: aaa1111',
      'END_COMMIT: bbb2222',
      '',
      'SUPERVISOR ARTIFACT',
      'Status: DONE',
      'Files changed: .pi/skills/merge-to-main/SKILL.md',
      'Verification:',
      '- `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0; output contained the lifecycle guard wording.',
      '- Manual review confirms merge-to-main does not bypass accepted/close lifecycle; observed result PASS.',
      '- `pnpm test tests/extensions/review-workflow.test.ts --reporter dot`: N/A because changed files proof is docs-only.',
      '- `npx vue-tsc --noEmit`: N/A because changed files proof is docs-only.',
      'Artifact status: complete',
    ].join('\n')
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { beadDescription, changedFiles: '.pi/skills/merge-to-main/SKILL.md', supervisorComments })
    const matrix = String(execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))?.args[3] ?? '')

    expect(matrix).toContain('| `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0. | command: rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md; exit code: 0')
    expect(matrix).toContain('| Manual review confirms merge-to-main does not bypass accepted/close lifecycle. | command: manual review; exit code: not recorded')
    expect(matrix).toContain('| If TypeScript extension code changes: `pnpm test tests/extensions/review-workflow.test.ts --reporter dot` exits 0. | N/A: whitelisted conditional verification is not applicable to docs-only changed files (.pi/skills/merge-to-main/SKILL.md); changed-files proof is present in supervisor evidence. | N/A |')
    expect(matrix).toContain('| If TypeScript extension code changes: `npx vue-tsc --noEmit` exits 0. | N/A: whitelisted conditional verification is not applicable to docs-only changed files (.pi/skills/merge-to-main/SKILL.md); changed-files proof is present in supervisor evidence. | N/A |')
    expect(matrix).toContain('All required acceptance rows are PASS or explicitly N/A.')
    expect(matrix).not.toContain('| NOT RUN |')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.join(' ').includes('--status accepted'))).toBe(true)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close' && call.args[1] === 'bead-a')).toBe(true)
    expect(result.details.error).toBeUndefined()
  })

  it('keeps docs-only verification rows NOT RUN and blocks close when supervisor evidence is missing', async () => {
    const beadDescription = [
      '### Acceptance criteria',
      '- review_bead preserves fail-closed acceptance policy.',
      '### Verification / acceptance checks',
      '- `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0.',
      '- Manual review confirms merge-to-main does not bypass accepted/close lifecycle.',
    ].join('\n')
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { beadDescription, changedFiles: '.pi/skills/merge-to-main/SKILL.md', supervisorComments: 'DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: __WORKTREE__\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222' })
    const matrix = String(execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))?.args[3] ?? '')

    expect(matrix).toContain('| NOT RUN |')
    expect(matrix).toContain('BLOCKER: acceptance matrix contains NOT RUN')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.join(' ').includes('--status accepted'))).toBe(false)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(result.details.error).toContain('ACCEPTANCE MATRIX contains blocking rows')
  })

  it('ignores incomplete supervisor artifacts and Verification: not run for matrix evidence', async () => {
    const beadDescription = [
      '### Verification / acceptance checks',
      '- `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0.',
    ].join('\n')
    const supervisorComments = [
      'DISPATCH RESULT (test-supervisor)',
      '',
      'BRANCH: task/bead-a',
      'WORKTREE: __WORKTREE__',
      'START_COMMIT: aaa1111',
      'END_COMMIT: bbb2222',
      '',
      'SUPERVISOR ARTIFACT',
      'Status: DONE',
      'Files changed: .pi/skills/merge-to-main/SKILL.md',
      'Verification: not run',
      '- `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0.',
      'Artifact status: incomplete',
    ].join('\n')
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { beadDescription, changedFiles: '.pi/skills/merge-to-main/SKILL.md', supervisorComments })
    const matrix = String(execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))?.args[3] ?? '')

    expect(matrix).toContain('| `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0. | Required verification evidence missing')
    expect(matrix).toContain('| NOT RUN |')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(result.details.error).toContain('ACCEPTANCE MATRIX contains blocking rows')
  })

  it('keeps adjacent rg without its own exit as NOT RUN instead of inheriting the next bullet PASS', async () => {
    const beadDescription = [
      '### Verification / acceptance checks',
      '- `rg "foo" file.md` exits 0.',
      '- Manual review confirms missing docs-only evidence remains NOT RUN and close is blocked.',
    ].join('\n')
    const supervisorComments = [
      'DISPATCH RESULT (test-supervisor)',
      '',
      'BRANCH: task/bead-a',
      'WORKTREE: __WORKTREE__',
      'START_COMMIT: aaa1111',
      'END_COMMIT: bbb2222',
      '',
      'SUPERVISOR ARTIFACT',
      'Status: DONE',
      'Files changed: file.md',
      'Verification:',
      '- `rg "foo" file.md`',
      '- Manual review confirms missing docs-only evidence remains NOT RUN and close is blocked; observed result PASS.',
      'Artifact status: complete',
    ].join('\n')
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { beadDescription, changedFiles: 'file.md', supervisorComments })
    const matrix = String(execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))?.args[3] ?? '')

    expect(matrix).toContain('| `rg "foo" file.md` exits 0. | Required verification evidence missing')
    expect(matrix).toContain('| NOT RUN |')
    expect(matrix).not.toMatch(/\| `rg "foo" file.md` exits 0\. \| command: rg "foo" file.md;[^|]*\| PASS \|/)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(result.details.error).toContain('ACCEPTANCE MATRIX contains blocking rows')
  })

  it('does not fall back to older PASS evidence when the latest artifact is incomplete or not run', async () => {
    const beadDescription = [
      '### Verification / acceptance checks',
      '- `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0.',
    ].join('\n')
    const supervisorComments = [
      'DISPATCH RESULT (old)',
      '',
      'BRANCH: task/bead-a',
      'WORKTREE: __WORKTREE__',
      'START_COMMIT: aaa1111',
      'END_COMMIT: bbb2222',
      '',
      'SUPERVISOR ARTIFACT',
      'Status: DONE',
      'Files changed: .pi/skills/merge-to-main/SKILL.md',
      'Verification:',
      '- `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0; output contained the lifecycle guard wording.',
      'Artifact status: complete',
      '',
      'WORKFLOW SUBMIT FOR REVIEW',
      '',
      'BRANCH: task/bead-a',
      'WORKTREE: __WORKTREE__',
      'START_COMMIT: aaa1111',
      'END_COMMIT: bbb2222',
      '',
      'SUPERVISOR ARTIFACT',
      'Status: DONE',
      'Files changed: .pi/skills/merge-to-main/SKILL.md',
      'Verification: not run',
      'Artifact status: incomplete',
    ].join('\n')
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { beadDescription, changedFiles: '.pi/skills/merge-to-main/SKILL.md', supervisorComments })
    const matrix = String(execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))?.args[3] ?? '')

    expect(matrix).toContain('| `rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md` exits 0. | Required verification evidence missing')
    expect(matrix).toContain('| NOT RUN |')
    expect(matrix).not.toContain('command: rg "Direct close bypass" .pi/skills/merge-to-main/SKILL.md; exit code: 0')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
    expect(result.details.error).toContain('ACCEPTANCE MATRIX contains blocking rows')
  })

  it('does not treat docs/foo.ts as docs-only N/A for conditional test rows', async () => {
    const beadDescription = [
      '### Verification / acceptance checks',
      '- If TypeScript extension code changes: `pnpm test tests/extensions/review-workflow.test.ts --reporter dot` exits 0.',
      '- If TypeScript extension code changes: `npx vue-tsc --noEmit` exits 0.',
    ].join('\n')
    const supervisorComments = [
      'DISPATCH RESULT (test-supervisor)',
      '',
      'BRANCH: task/bead-a',
      'WORKTREE: __WORKTREE__',
      'START_COMMIT: aaa1111',
      'END_COMMIT: bbb2222',
      '',
      'SUPERVISOR ARTIFACT',
      'Status: DONE',
      'Files changed: docs/foo.ts',
      'Verification:',
      '- Manual review confirms fail-closed policy; observed result PASS.',
      'Artifact status: complete',
    ].join('\n')
    const { execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { beadDescription, changedFiles: 'docs/foo.ts', supervisorComments })
    const matrix = String(execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))?.args[3] ?? '')

    expect(matrix).not.toContain('docs-only changed files (docs/foo.ts)')
    expect(matrix).not.toContain('whitelisted conditional verification is not applicable to docs-only')
    expect(matrix).toContain('| If TypeScript extension code changes: `pnpm test tests/extensions/review-workflow.test.ts --reporter dot` exits 0. | command:')
    expect(matrix).toContain('| PASS |')
  })

  it('does not classify fail-closed policy wording as FAIL', async () => {
    const beadDescription = [
      '### Verification / acceptance checks',
      '- Manual review confirms fail-closed policy.',
    ].join('\n')
    const supervisorComments = [
      'DISPATCH RESULT (test-supervisor)',
      '',
      'BRANCH: task/bead-a',
      'WORKTREE: __WORKTREE__',
      'START_COMMIT: aaa1111',
      'END_COMMIT: bbb2222',
      '',
      'SUPERVISOR ARTIFACT',
      'Status: DONE',
      'Files changed: .pi/skills/merge-to-main/SKILL.md',
      'Verification:',
      '- Manual review confirms fail-closed policy; observed result PASS.',
      'Artifact status: complete',
    ].join('\n')
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', { beadDescription, changedFiles: '.pi/skills/merge-to-main/SKILL.md', supervisorComments })
    const matrix = String(execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').startsWith('ACCEPTANCE MATRIX:'))?.args[3] ?? '')

    expect(matrix).toContain('| Manual review confirms fail-closed policy. | command: manual review; exit code: not recorded')
    expect(matrix).toContain('| PASS |')
    expect(matrix).not.toContain('| FAIL |')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close' && call.args[1] === 'bead-a')).toBe(true)
    expect(result.details.error).toBeUndefined()
  })

  it('delegates once on runtime hash mismatch with cwd+env+forwarded params and never closes on parent stale path', async () => {
    const delegateCalls: Array<Record<string, unknown>> = []
    const { createHash } = await import('node:crypto')
    try {
      const fixture = createFakeReviewerWorktree('VERDICT: APPROVED\nReady')
      mkdirSync(join(fixture.cwd, '.pi', 'extensions', 'review-workflow'), { recursive: true })
      writeFileSync(join(fixture.cwd, '.pi', 'extensions', 'review-workflow', 'index.ts'), 'stale task worktree runtime source')
      const worktreeSha = createHash('sha256').update(readFileSync(join(fixture.cwd, '.pi/extensions/review-workflow/index.ts'))).digest('hex')
      let registeredTool: any
      const execCalls: Array<{ command: string; args: string[] }> = []
      let beadStatus = 'inreview'
      const commentLog: string[] = [
        `DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: ${fixture.cwd}\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222`,
      ]
      const pi = {
        events: { emit() {} },
        registerTool(tool: any) {
          if (tool.name === 'review_bead') registeredTool = tool
        },
        registerCommand() {},
        exec: async (command: string, args: string[]) => {
          execCalls.push({ command, args })
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: beadStatus }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: commentLog.join('\n\n'), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') {
            commentLog.push(String(args[3] ?? ''))
            return { stdout: '', stderr: '', code: 0 }
          }
          if (command === 'bd' && args[0] === 'update' && args.includes('--status')) {
            beadStatus = String(args[args.indexOf('--status') + 1] ?? beadStatus)
            return { stdout: '', stderr: '', code: 0 }
          }
          if (command === 'bd' && args[0] === 'close') {
            beadStatus = 'closed'
            return { stdout: '', stderr: '', code: 0 }
          }
          if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} branch --show-current`) return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} rev-parse --show-toplevel`) return { stdout: `${fixture.cwd}\n`, stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} diff --name-only aaa1111..bbb2222`) {
            return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
          }
          return { stdout: '', stderr: '', code: 0 }
        },
      }

      try {
        setReviewRuntimeDelegateForTestOverride(async (params) => {
          delegateCalls.push({
            beadId: params.beadId,
            startCommit: params.startCommit,
            endCommit: params.endCommit,
            worktreePath: params.worktreePath,
          })
          commentLog.push(`REVIEW RUNTIME: worktree-fresh, sha256=${worktreeSha}`)
          beadStatus = 'closed'
          return { code: 0, stdout: 'child closed', stderr: '', method: 'test-override' }
        })
        reviewWorkflowExtension(pi as any)

        const result = await registeredTool.execute(
          'call-1',
          { beadId: 'bead-a', worktreePath: fixture.cwd, startCommit: 'aaa1111', endCommit: 'bbb2222' },
          undefined,
          undefined,
          { cwd: '/repo/main' },
        )

        expect(delegateCalls).toHaveLength(1)
        expect(delegateCalls[0]).toMatchObject({
          beadId: 'bead-a',
          startCommit: 'aaa1111',
          endCommit: 'bbb2222',
          worktreePath: fixture.cwd,
        })
        expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').includes('REVIEW RUNTIME DELEGATE'))).toBe(true)
        expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
        expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.includes('simplified'))).toBe(false)
        expect(result.details.error).toBeUndefined()
        expect(result.content[0].text).toContain('Parent delegated full review path')
        expect(result.content[0].text).toContain('bd status=closed')
      } finally {
        fixture.cleanup()
      }
    } finally {
      setReviewRuntimeDelegateForTestOverride(null)
    }
  })

  it('blocks nested delegate when PI_REVIEW_RUNTIME_DELEGATED=1 on mismatch', async () => {
    const previous = process.env.PI_REVIEW_RUNTIME_DELEGATED
    process.env.PI_REVIEW_RUNTIME_DELEGATED = '1'
    let delegateCalled = false
    setReviewRuntimeDelegateForTestOverride(async () => {
      delegateCalled = true
      return { code: 0, stdout: '', stderr: '', method: 'test-override' }
    })
    try {
      const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', {
        changedFiles: '.pi/extensions/review-workflow/index.ts',
        reviewWorkflowRuntimeSource: 'stale task worktree runtime source',
      })
      expect(delegateCalled).toBe(false)
      expect(result.content[0].text).toContain('Nested delegate refused')
      expect(result.content[0].text).toContain('PI_REVIEW_RUNTIME_DELEGATED=1')
      expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
      expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').includes('REVIEW RUNTIME DELEGATE'))).toBe(false)
    } finally {
      setReviewRuntimeDelegateForTestOverride(null)
      if (previous === undefined) delete process.env.PI_REVIEW_RUNTIME_DELEGATED
      else process.env.PI_REVIEW_RUNTIME_DELEGATED = previous
    }
  })

  it('blocks when delegate spawn fails and does not close on parent path', async () => {
    setReviewRuntimeDelegateForTestOverride(async () => {
      throw new Error('spawn failed: pi missing')
    })
    try {
      const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', {
        changedFiles: '.pi/extensions/review-workflow/index.ts',
        reviewWorkflowRuntimeSource: 'stale task worktree runtime source',
      })
      expect(result.content[0].text).toContain('Delegate spawn/run failed')
      expect(result.content[0].text).toContain('spawn failed: pi missing')
      expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
      expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && String(call.args[3] ?? '').includes('REVIEW RUNTIME DELEGATE'))).toBe(true)
    } finally {
      setReviewRuntimeDelegateForTestOverride(null)
    }
  })

  it('treats delegated NOT APPROVED + inreview as successful parent outcome without close', async () => {
    setReviewRuntimeDelegateForTestOverride(async () => {
      throw new Error('should be replaced below')
    })
    try {
      const fixture = createFakeReviewerWorktree('unused')
      mkdirSync(join(fixture.cwd, '.pi', 'extensions', 'review-workflow'), { recursive: true })
      writeFileSync(join(fixture.cwd, '.pi', 'extensions', 'review-workflow', 'index.ts'), 'stale runtime body')
      let registeredTool: any
      const execCalls: Array<{ command: string; args: string[] }> = []
      let beadStatus = 'inreview'
      const commentLog: string[] = [
        `DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: ${fixture.cwd}\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222`,
      ]
      const pi = {
        events: { emit() {} },
        registerTool(tool: any) {
          if (tool.name === 'review_bead') registeredTool = tool
        },
        registerCommand() {},
        exec: async (command: string, args: string[]) => {
          execCalls.push({ command, args })
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: beadStatus }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: commentLog.join('\n\n'), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') {
            commentLog.push(String(args[3] ?? ''))
            return { stdout: '', stderr: '', code: 0 }
          }
          if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} branch --show-current`) return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} rev-parse --show-toplevel`) return { stdout: `${fixture.cwd}\n`, stderr: '', code: 0 }
          if (command === 'git' && args.join(' ') === `-C ${fixture.cwd} diff --name-only aaa1111..bbb2222`) {
            return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
          }
          return { stdout: '', stderr: '', code: 0 }
        },
      }
      setReviewRuntimeDelegateForTestOverride(async () => {
        commentLog.push('CODE REVIEW: NOT APPROVED\nFix required')
        beadStatus = 'inreview'
        return { code: 0, stdout: 'not approved', stderr: '', method: 'test-override' }
      })
      reviewWorkflowExtension(pi as any)
      const result = await registeredTool.execute(
        'call-1',
        { beadId: 'bead-a', worktreePath: fixture.cwd, startCommit: 'aaa1111', endCommit: 'bbb2222' },
        undefined,
        undefined,
        { cwd: '/repo/main' },
      )
      expect(result.details.error).toBeUndefined()
      expect(result.content[0].text).toContain('NOT APPROVED')
      expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'close')).toBe(false)
      fixture.cleanup()
    } finally {
      setReviewRuntimeDelegateForTestOverride(null)
    }
  })

  it('writes worktree-fresh marker before reviewer when delegated env matches runtime hash', async () => {
    const previous = process.env.PI_REVIEW_RUNTIME_DELEGATED
    process.env.PI_REVIEW_RUNTIME_DELEGATED = '1'
    try {
      const loadedRuntimeSource = readFileSync(join(process.cwd(), '.pi', 'extensions', 'review-workflow', 'index.ts'), 'utf8')
      const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', {
        changedFiles: '.pi/extensions/review-workflow/index.ts',
        reviewWorkflowRuntimeSource: loadedRuntimeSource,
      })
      const comments = execCalls
        .filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
        .map((call) => String(call.args[3] ?? ''))
      const markerIndex = comments.findIndex((text) => text.startsWith('REVIEW RUNTIME: worktree-fresh, sha256='))
      const reviewStartIndex = comments.findIndex((text) => text.startsWith('REVIEW START (review_bead)'))
      const closeIndex = execCalls.findIndex((call) => call.command === 'bd' && call.args[0] === 'close')

      expect(result.details.runtimeHashEvidence.status).toBe('matched')
      expect(markerIndex).toBeGreaterThanOrEqual(0)
      expect(reviewStartIndex).toBeGreaterThan(markerIndex)
      expect(closeIndex).toBeGreaterThan(reviewStartIndex)
      expect(result.details.error).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.PI_REVIEW_RUNTIME_DELEGATED
      else process.env.PI_REVIEW_RUNTIME_DELEGATED = previous
    }
  })

  it('allows approved review-workflow runtime change when load-time hash matches and records evidence before close', async () => {
    const loadedRuntimeSource = readFileSync(join(process.cwd(), '.pi', 'extensions', 'review-workflow', 'index.ts'), 'utf8')
    const { result, execCalls } = await runNonDryReview('VERDICT: APPROVED\nReady', {
      changedFiles: '.pi/extensions/review-workflow/index.ts',
      reviewWorkflowRuntimeSource: loadedRuntimeSource,
    })
    const statusUpdates = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'update').map((call) => call.args.join(' '))
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add').map((call) => call.args.join(' '))
    const acceptanceCommentIndex = comments.findIndex((args) => args.includes('ACCEPTANCE: review_bead acceptance checks completed.'))
    const closeIndex = execCalls.findIndex((call) => call.command === 'bd' && call.args[0] === 'close')

    expect(statusUpdates).toEqual(['update bead-a --status simplified', 'update bead-a --status reviewed', 'update bead-a --status accepted'])
    expect(result.details.runtimeHashEvidence.status).toBe('matched')
    expect(comments[acceptanceCommentIndex]).toContain('RUNTIME HASH EVIDENCE')
    expect(comments[acceptanceCommentIndex]).toContain('review-workflow runtime hash guard: PASS')
    expect(acceptanceCommentIndex).toBeGreaterThanOrEqual(0)
    expect(closeIndex).toBeGreaterThanOrEqual(0)
    expect(execCalls.findIndex((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && call.args.join(' ').includes('RUNTIME HASH EVIDENCE'))).toBeLessThan(closeIndex)
    expect(comments.some((args) => args.includes('REVIEW RUNTIME: worktree-fresh'))).toBe(false)
    expect(result.details.error).toBeUndefined()
  })

  it('does not delegate on dryRun mismatch', async () => {
    let delegateCalled = false
    setReviewRuntimeDelegateForTestOverride(async () => {
      delegateCalled = true
      return { code: 0, stdout: '', stderr: '', method: 'test-override' }
    })
    try {
      let registeredTool: any
      const pi = {
        registerTool(tool: any) {
          if (tool.name === 'review_bead') registeredTool = tool
        },
        registerCommand() {},
        exec: async (command: string, args: string[]) => {
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments') {
            return {
              stdout: 'DISPATCH\n\nBRANCH: feature/test\nWORKTREE: /repo/current\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222',
              stderr: '',
              code: 0,
            }
          }
          if (command === 'git' && args.includes('branch')) return { stdout: 'feature/test\n', stderr: '', code: 0 }
          if (command === 'git' && args.join(' ').includes('rev-parse --show-toplevel')) return { stdout: '/repo/current\n', stderr: '', code: 0 }
          if (command === 'git' && args.includes('diff')) return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 0 }
        },
      }
      // Force mismatch by pointing worktree path at a temp file with different contents via dryRun on process.cwd
      // dryRun evaluates hash against real worktree file; if cwd is project root and loaded hash matches, status is matched.
      // Use explicit worktree with different source via a temp dir.
      const cwd = mkdtempSync(join(tmpdir(), 'review-dry-mismatch-'))
      mkdirSync(join(cwd, '.pi', 'extensions', 'review-workflow'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'extensions', 'review-workflow', 'index.ts'), 'different runtime for dryRun')
      const pi2 = {
        registerTool(tool: any) {
          if (tool.name === 'review_bead') registeredTool = tool
        },
        registerCommand() {},
        exec: async (command: string, args: string[]) => {
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview' }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments') {
            return {
              stdout: `DISPATCH\n\nBRANCH: feature/test\nWORKTREE: ${cwd}\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222`,
              stderr: '',
              code: 0,
            }
          }
          if (command === 'git' && args.includes('branch')) return { stdout: 'feature/test\n', stderr: '', code: 0 }
          if (command === 'git' && args.join(' ').includes('rev-parse --show-toplevel')) return { stdout: `${cwd}\n`, stderr: '', code: 0 }
          if (command === 'git' && args.includes('diff')) return { stdout: '.pi/extensions/review-workflow/index.ts\n', stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 0 }
        },
      }
      reviewWorkflowExtension(pi2 as any)
      const result = await registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: cwd, dryRun: true }, undefined, undefined, { cwd })
      expect(delegateCalled).toBe(false)
      expect(result.details.runtimeHashEvidence.status).toBe('mismatch')
      expect(result.content[0].text).toContain('review-workflow runtime hash guard: mismatch')
      rmSync(cwd, { recursive: true, force: true })
      void pi
    } finally {
      setReviewRuntimeDelegateForTestOverride(null)
    }
  })
})

describe('review-bead visible code-reviewer hop', () => {
  const skill = readFileSync(join(process.cwd(), '.pi/skills/review-bead/SKILL.md'), 'utf8')

  it('pins interactive dispatch_reviewer transport=cmux and does not auto-call review_bead after verdict', () => {
    expect(skill).toContain('dispatch_reviewer(beadId=<ID>, transport=cmux, cwd=<workflowState.worktreePath>)')
    expect(skill).toContain('status=verdict` → do not call `review_bead`')
    expect(skill).toContain('followup_visible_dispatch({ beadId, role: "code-reviewer", task })')
    expect(skill).toContain('complete_visible_dispatch` must not spawn a supervisor after `NOT APPROVED`')
    expect(skill).toContain('While a live code-reviewer pane exists, do not call `review_bead`')
  })

  it('documents internal runtime hash auto-delegate without changing cmux hop pins', () => {
    expect(skill).toContain('REVIEW RUNTIME DELEGATE')
    expect(skill).toContain('worktree-fresh')
    expect(skill).toContain('PI_REVIEW_RUNTIME_DELEGATED')
    expect(skill).toContain('hash mismatch')
    expect(skill).toContain('dispatch_reviewer(beadId=<ID>, transport=cmux, cwd=<workflowState.worktreePath>)')
  })
})

describe('review_bead agent model routing', () => {
  it('passes --model from project agent-models.json for code-reviewer', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'review-model-'))
    mkdirSync(join(cwd, '.pi', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'agents', 'code-reviewer.md'), '---\nname: code-reviewer\ndescription: fixture\n---\nReview body\n')
    writeFileSync(
      join(cwd, '.pi', 'agent-models.json'),
      JSON.stringify({
        classes: { strong: 'xai/grok-4.5' },
        roles: {},
        agentClasses: { 'code-reviewer': 'strong' },
      }, null, 2),
    )

    const captured: string[][] = []
    setSpawnForReviewTestOverride(((command: string, args: string[]) => {
      captured.push(args)
      const proc: any = new EventEmitter()
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = () => true
      queueMicrotask(() => {
        proc.stdout.write('VERDICT: NOT APPROVED\nneed more evidence\n')
        proc.stdout.end()
        proc.stderr.end()
        proc.emit('close', 0)
      })
      return proc
    }) as any)

    let registeredTool: any
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'review_bead') registeredTool = tool
      },
      registerCommand() {},
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'inreview', description: '### Acceptance criteria\n- x\n### Verification / acceptance checks\n- echo ok' }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') {
          return {
            stdout: `DISPATCH RESULT (test-supervisor)\n\nBRANCH: task/bead-a\nWORKTREE: ${cwd}\nSTART_COMMIT: aaa1111\nEND_COMMIT: bbb2222`,
            stderr: '',
            code: 0,
          }
        }
        if (command === 'git' && args.join(' ') === `-C ${cwd} branch --show-current`) return { stdout: 'task/bead-a\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${cwd} rev-parse --show-toplevel`) return { stdout: `${cwd}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${cwd} diff --name-only aaa1111..bbb2222`) return { stdout: 'README.md\n', stderr: '', code: 0 }
        if (command === 'bd') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    reviewWorkflowExtension(pi as any)
    await registeredTool.execute('call-1', { beadId: 'bead-a', worktreePath: cwd }, undefined, undefined, {
      cwd,
      sessionManager: {
        getEntries: () => [{
          type: 'custom',
          customType: 'workflow-state',
          data: { activeBead: 'bead-a', branch: 'task/bead-a', worktreePath: cwd, startCommit: 'aaa1111' },
        }],
      },
    })

    expect(captured.length).toBeGreaterThan(0)
    const spawnArgs = captured[0]
    expect(spawnArgs).toBeDefined()
    expect(spawnArgs!).toContain('--model')
    expect(spawnArgs![spawnArgs!.indexOf('--model') + 1]).toBe('xai/grok-4.5')

    writeFileSync(join(cwd, '.pi', 'agent-models.json'), JSON.stringify({ classes: {}, roles: {}, agentClasses: {} }, null, 2))
    captured.length = 0
    await registeredTool.execute('call-2', { beadId: 'bead-a', worktreePath: cwd }, undefined, undefined, {
      cwd,
      sessionManager: {
        getEntries: () => [{
          type: 'custom',
          customType: 'workflow-state',
          data: { activeBead: 'bead-a', branch: 'task/bead-a', worktreePath: cwd, startCommit: 'aaa1111' },
        }],
      },
    })
    expect(captured.length).toBeGreaterThan(0)
    expect(captured[0]).not.toContain('--model')

    rmSync(cwd, { recursive: true, force: true })
  })
})
