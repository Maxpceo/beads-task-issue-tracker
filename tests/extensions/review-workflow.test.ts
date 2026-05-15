import { describe, expect, it } from 'vitest'

import reviewWorkflowExtension from '../../.pi/extensions/review-workflow/index'

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

    expect(result.content[0].text).toContain('no matching branch/worktree/start ownership evidence')
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

    expect(result.content[0].text).toContain('no matching branch/worktree/start ownership evidence')
    expect(result.content[0].text).toContain('workflow_reset')
    expect(result.content[0].text).toContain('confirm takeover')
    expect(execCalls).not.toContainEqual({ command: 'git', args: ['diff', '--name-only', 'aaa1111..HEAD'] })
  })
})
