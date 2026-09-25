import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import workflowStateExtension, { currentRuntimeOwnerKey, hasSessionOwnershipEvidence } from '../../.pi/extensions/workflow-state/index'

const WORKTREE_ROOT = path.join(os.homedir(), 'Projects', 'worktrees', 'beads-task-issue-tracker')

const VISIBLE_REVIEW_DISPATCH = 'dispatch_reviewer(beadId=<ID>, transport=cmux, cwd=<workflowState.worktreePath>)'

function makeHarness(options: {
  branch: string
  worktreePath: string
  startCommit: string
  issues: Record<string, { status: string; comments: string }>
  claimStatusById?: Record<string, string>
  statusUpdateById?: Record<string, string>
  commentAddCode?: number
  entries?: Array<{ type: string; customType?: string; data?: unknown }>
  sessionKey?: string
  omitSessionKey?: boolean
  ctxCwd?: string
  /** Optional Pi interactive flag; omit by default (non-UI). Do not default true. */
  hasUI?: boolean
  processBranch?: string
  processWorktreePath?: string
  processStartCommit?: string
  staleScopedGitError?: boolean
  gitScopes?: Record<string, { branch: string; worktreePath: string; startCommit: string }>
  worktreePorcelain?: { stdout?: string; stderr?: string; code?: number }
}) {
  const eventHandlers = new Map<string, (event: unknown, ctx: any) => unknown>()
  const commandHandlers = new Map<string, any>()
  const toolHandlers = new Map<string, any>()
  const appended: Array<{ type: string; data: unknown }> = []
  const notifications: Array<{ message: string; level?: string }> = []
  const statuses: Record<string, string | undefined> = {}
  const execCalls: Array<{ command: string; args: string[] }> = []

  const processBranch = options.processBranch ?? options.branch
  const processWorktreePath = options.processWorktreePath ?? options.worktreePath
  const processStartCommit = options.processStartCommit ?? options.startCommit

  const pi: any = {
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'git' && args[0] === '-C') {
        if (args[1] === options.ctxCwd && options.staleScopedGitError) throw new Error('This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().')
        const scope = options.gitScopes?.[String(args[1])] ?? (args[1] === options.ctxCwd ? { branch: options.branch, worktreePath: options.worktreePath, startCommit: options.startCommit } : undefined)
        if (scope) {
          const scopedArgs = args.slice(2).join(' ')
          if (scopedArgs === 'branch --show-current') return { stdout: `${scope.branch}\n`, stderr: '', code: 0 }
          if (scopedArgs === 'rev-parse HEAD') return { stdout: `${scope.startCommit}\n`, stderr: '', code: 0 }
          if (scopedArgs === 'rev-parse --show-toplevel') return { stdout: `${scope.worktreePath}\n`, stderr: '', code: 0 }
          if (scopedArgs === 'worktree list --porcelain') {
            const porcelain = options.worktreePorcelain ?? { stdout: '', stderr: '', code: 0 }
            return { stdout: porcelain.stdout ?? '', stderr: porcelain.stderr ?? '', code: porcelain.code ?? 0 }
          }
        }
      }
      if (command === 'git' && (args.join(' ') === 'worktree list --porcelain' || (args[0] === '-C' && args.slice(2).join(' ') === 'worktree list --porcelain'))) {
        const porcelain = options.worktreePorcelain ?? { stdout: '', stderr: '', code: 0 }
        return { stdout: porcelain.stdout ?? '', stderr: porcelain.stderr ?? '', code: porcelain.code ?? 0 }
      }
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: `${processBranch}\n`, stderr: '', code: 0 }
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { stdout: `${processStartCommit}\n`, stderr: '', code: 0 }
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: `${processWorktreePath}\n`, stderr: '', code: 0 }

      if (command === 'bd' && args[0] === 'list') {
        const status = args.find((arg) => arg.startsWith('--status='))?.slice('--status='.length)
        const issues = Object.entries(options.issues)
          .filter(([, issue]) => issue.status === status)
          .map(([id]) => ({ id }))
        return { stdout: JSON.stringify(issues), stderr: '', code: 0 }
      }
      if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') {
        const id = args[2] ?? ''
        const issue = options.issues[id]
        if (!issue) return { stdout: '', stderr: 'issue not found', code: 1 }
        if (options.commentAddCode && options.commentAddCode !== 0) return { stdout: '', stderr: 'comment add failed', code: options.commentAddCode }
        issue.comments = [issue.comments, args[3] ?? ''].filter(Boolean).join('\n\n')
        return { stdout: JSON.stringify({ issue_id: id, text: args[3] ?? '' }), stderr: '', code: 0 }
      }
      if (command === 'bd' && args[0] === 'comments') {
        const id = args[1] ?? ''
        return { stdout: options.issues[id]?.comments ?? '', stderr: '', code: options.issues[id] ? 0 : 1 }
      }
      if (command === 'bd' && args[0] === 'show') {
        const id = args[1] ?? ''
        const issue = options.issues[id]
        return { stdout: JSON.stringify(issue ? { id, status: issue.status } : {}), stderr: '', code: issue ? 0 : 1 }
      }
      if (command === 'bd' && args[0] === 'update' && args.includes('--claim')) {
        const id = args[1] ?? ''
        const issue = options.issues[id]
        if (!issue) return { stdout: JSON.stringify({}), stderr: '', code: 1 }
        const nextStatus = options.claimStatusById?.[id] ?? 'in_progress'
        issue.status = nextStatus
        return { stdout: JSON.stringify({ id, status: nextStatus }), stderr: '', code: 0 }
      }
      if (command === 'bd' && args[0] === 'update' && args.includes('--status')) {
        const id = args[1] ?? ''
        const issue = options.issues[id]
        if (!issue) return { stdout: JSON.stringify({}), stderr: '', code: 1 }
        const requestedStatus = args[args.indexOf('--status') + 1] ?? issue.status
        const nextStatus = options.statusUpdateById?.[id] ?? requestedStatus
        issue.status = nextStatus
        return { stdout: JSON.stringify({ id, status: nextStatus }), stderr: '', code: 0 }
      }
      return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
    },
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    events: { on: (name: string, handler: (event: unknown, ctx: any) => unknown) => eventHandlers.set(name, handler) },
    on: (name: string, handler: (event: unknown, ctx: any) => unknown) => eventHandlers.set(name, handler),
    registerCommand: (name: string, config: any) => commandHandlers.set(name, config),
    registerTool: (tool: any) => toolHandlers.set(tool.name, tool),
  }

  const ctx: any = {
    cwd: options.ctxCwd,
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionId: () => options.omitSessionKey ? undefined : (options.sessionKey ?? 'session-current'),
    },
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }), setStatus: (key: string, value: string | undefined) => { statuses[key] = value }, theme: { fg: (_style: string, value: string) => value } },
  }
  if (options.hasUI !== undefined) ctx.hasUI = options.hasUI

  workflowStateExtension(pi)

  return { eventHandlers, commandHandlers, toolHandlers, ctx, appended, notifications, statuses, execCalls }
}

describe('Pi workflow-state session-scoped recovery', () => {
  it('uses ctx.cwd git scope after reload instead of process cwd primary checkout', async () => {
    const { eventHandlers, ctx } = makeHarness({
      branch: 'task/worktree-3',
      worktreePath: '/repo/worktrees/worktree-3',
      startCommit: 'worktree-head',
      processBranch: 'main',
      processWorktreePath: '/repo/primary',
      processStartCommit: 'main-head',
      ctxCwd: '/repo/worktrees/worktree-3',
      issues: {},
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('branch=task/worktree-3')
    expect(context.message.content).toContain('worktree=/repo/worktrees/worktree-3')
    expect(context.message.content).not.toContain('branch=main')
    expect(context.message.content).not.toContain('worktree=-')
  })

  it('keeps a clean session idle when global inreview beads have no matching ownership evidence', async () => {
    const { eventHandlers, ctx } = makeHarness({
      branch: 'main',
      worktreePath: '/repo',
      startCommit: 'current-head',
      issues: {
        'bead-tf9p': { status: 'inreview', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: old-branch\nSTART_COMMIT: old-head' },
        'bead-15tu': { status: 'inreview', comments: 'CODE REVIEW: pending from another session' },
      },
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
  })

  it('clears restored active bead with a foreign session marker even when branch/worktree comments match', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-foreign-session': { status: 'inreview', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'inreview',
            activeBead: 'bead-foreign-session',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:other-session',
            planMode: 'off',
            mergeSlotHeld: false,
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(notifications.at(-1)?.message).toContain('stale or foreign')
  })

  it('clears stale restored active bead when ownership does not match current worktree', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/main',
      startCommit: 'current-head',
      issues: {
        'bead-tf9p': { status: 'inreview', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/old\nWORKTREE: /repo/old\nSTART_COMMIT: old-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: { state: 'inreview', activeBead: 'bead-tf9p', branch: 'main', planMode: 'off', mergeSlotHeld: false, updatedAt: new Date().toISOString() },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(notifications).toEqual([])
  })

  it('clears restored active bead with explicit foreign worktree even when start commit matches', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'shared-head',
      issues: {
        'bead-foreign': { status: 'inreview', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/other\nWORKTREE: /repo/other\nSTART_COMMIT: shared-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'inreview',
            activeBead: 'bead-foreign',
            branch: 'fix/other',
            worktreePath: '/repo/other',
            startCommit: 'shared-head',
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(notifications).toEqual([])
  })

  it('clears restored active bead when bd status is closed even if session mode is non-terminal', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-closed': { status: 'closed', comments: '' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'implementing',
            activeBead: 'bead-closed',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=closed')
    expect(context.message.content).toContain('sessionMode=closed')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).not.toContain('state=implementing')
    expect(context.message.content).not.toContain('sessionMode=implementing')
    expect(context.message.content).not.toContain('bead=bead-closed')
    expect(notifications.at(-1)?.message).toContain('terminal bd status closed')
  })

  it('clears restored active bead when bd status is closed even if session mode is already terminal', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-closed': { status: 'closed', comments: '' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'closed',
            activeBead: 'bead-closed',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            endCommit: 'old-end',
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=closed')
    expect(context.message.content).toContain('sessionMode=closed')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('end=-')
    expect(context.message.content).not.toContain('bead=bead-closed')
    expect(notifications.at(-1)?.message).toContain('terminal bd status closed')
  })

  it('reconciles workflow-status/footer when active bead becomes closed after session start', async () => {
    const issues: Record<string, { status: string; comments: string }> = {
      'bead-closed': { status: 'inreview', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
    }
    const { eventHandlers, commandHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues,
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'reviewing',
            activeBead: 'bead-closed',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            endCommit: 'old-end',
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    issues['bead-closed']!.status = 'closed'

    await commandHandlers.get('workflow-status')?.handler('', ctx)

    expect(notifications.at(-2)?.message).toContain('terminal bd status closed')
    expect(notifications.at(-1)?.message).toContain('state=closed')
    expect(notifications.at(-1)?.message).toContain('sessionMode=closed')
    expect(notifications.at(-1)?.message).toContain('bead=-')
    expect(notifications.at(-1)?.message).toContain('end=-')
    expect(notifications.at(-1)?.message).not.toContain('state=reviewing')
    expect(notifications.at(-1)?.message).not.toContain('bead=bead-closed')
  })

  it('reconciles /workflow-update before notifying or persisting a terminal active bead', async () => {
    const { commandHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-closed': { status: 'closed', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
      },
    })

    await commandHandlers.get('workflow-update')?.handler(
      'state=reviewing bead=bead-closed branch=fix/current worktree=/repo/current start=current-head end=old-end',
      ctx,
    )

    expect(appended).toHaveLength(1)
    expect(appended.at(-1)?.data).toMatchObject({ state: 'closed', sessionMode: 'closed' })
    expect((appended.at(-1)?.data as any).activeBead).toBeUndefined()
    expect((appended.at(-1)?.data as any).endCommit).toBeUndefined()
    expect(notifications.at(-2)?.message).toContain('terminal bd status closed')
    expect(notifications.at(-1)?.message).toContain('state=closed')
    expect(notifications.at(-1)?.message).toContain('sessionMode=closed')
    expect(notifications.at(-1)?.message).toContain('bead=-')
    expect(notifications.at(-1)?.message).toContain('end=-')
    expect(notifications.at(-1)?.message).not.toContain('state=reviewing')
    expect(notifications.at(-1)?.message).not.toContain('bead=bead-closed')
  })

  it('reconciles workflow-state:update before exposing a terminal active bead in context', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-closed': { status: 'closed', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
      },
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    await eventHandlers.get('workflow-state:update')?.({
      state: 'reviewing',
      activeBead: 'bead-closed',
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      endCommit: 'old-end',
      ctx,
    }, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=closed')
    expect(context.message.content).toContain('sessionMode=closed')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('end=-')
    expect(context.message.content).not.toContain('state=reviewing')
    expect(context.message.content).not.toContain('bead=bead-closed')
    expect(notifications.at(-1)?.message).toContain('terminal bd status closed')
  })

  it('keeps workflow-state:update non-fatal when the event ctx is stale after session replacement', async () => {
    const { eventHandlers, ctx, appended } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      processBranch: 'fix/current',
      processWorktreePath: '/repo/current',
      processStartCommit: 'current-head',
      ctxCwd: '/repo/current',
      staleScopedGitError: true,
      issues: {
        'bead-current': { status: 'in_progress', comments: '' },
      },
    })

    await expect(eventHandlers.get('workflow-state:update')?.({
      state: 'implementing',
      activeBead: 'bead-current',
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      ctx,
    }, ctx)).resolves.toBeUndefined()

    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-current',
      state: 'implementing',
    })
  })

  it('keeps restored active bead when session state matches current worktree even without comments', async () => {
    const { eventHandlers, ctx } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-current': { status: 'inreview', comments: '' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'inreview',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=inreview')
    expect(context.message.content).toContain('bead=bead-current')
  })

  it('coerces restored implementing session to inreview when live bd status is inreview', async () => {
    const { eventHandlers, ctx } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-current': { status: 'inreview', comments: '' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'implementing',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=inreview')
    expect(context.message.content).toContain('bead=bead-current')
    expect(context.message.content).toContain('sessionMode=inreview')
    expect(context.message.content).toContain('bdStatus=inreview')
    expect(context.message.content).toContain('[PI INREVIEW GUARD]')
    expect(context.message.content).toContain('review-bead / review_bead')
    expect(context.message.content).not.toContain(VISIBLE_REVIEW_DISPATCH)
    expect(context.message.content).toContain('Не заявляй, что review_bead или dispatch_reviewer недоступны')
    expect(context.message.content).toContain('tool реально отсутствует в текущем tool surface')
    expect(context.message.content).toContain('typed call вернул ошибку до запуска review')
    expect(context.message.content).toContain('BLOCKED на русском с точным evidence')
  })

  it('interactive hasUI GUARD pins visible dispatch_reviewer first with review_bead as headless-fallback', async () => {
    const { eventHandlers, ctx } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      hasUI: true,
      issues: {
        'bead-current': { status: 'inreview', comments: '' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'implementing',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('[PI INREVIEW GUARD]')
    expect(context.message.content).toContain(VISIBLE_REVIEW_DISPATCH)
    expect(context.message.content).toContain('headless-fallback')
    expect(context.message.content).toContain('review_bead')
    const dispatchIdx = context.message.content.indexOf(VISIBLE_REVIEW_DISPATCH)
    const reviewBeadIdx = context.message.content.indexOf('review_bead — только headless-fallback')
    expect(dispatchIdx).toBeGreaterThan(-1)
    expect(reviewBeadIdx).toBeGreaterThan(dispatchIdx)
  })

  it('keeps restored current-scope active bead when old foreign comments are followed by current ownership evidence', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-current': {
          status: 'inreview',
          comments: [
            'DISPATCH (test-supervisor)',
            'BRANCH: fix/other',
            'WORKTREE: /repo/other',
            'START_COMMIT: old-head',
            'REDISPATCH (test-supervisor)',
            'BRANCH: fix/current',
            'WORKTREE: /repo/current',
            'START_COMMIT: current-head',
          ].join('\n'),
        },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'inreview',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=inreview')
    expect(context.message.content).toContain('bead=bead-current')
    expect(notifications).toEqual([])
  })

  it('keeps same-session inreview state when bd status moved back to in_progress and displays bd status', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-current': { status: 'in_progress', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'inreview',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=inreview')
    expect(context.message.content).toContain('bead=bead-current')
    expect(context.message.content).toContain('bdStatus=in_progress')
    expect(notifications).toEqual([])
  })

  it('keeps same-session planning state when bd status is still broad in_progress', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-current': { status: 'in_progress', comments: 'PLAN APPROVED\n\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'planning',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'strict',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=planning')
    expect(context.message.content).toContain('bead=bead-current')
    expect(context.message.content).not.toContain('state=implementing')
    expect(notifications).toEqual([])
  })

  it('keeps same-session plan_approved state when bd status is still broad in_progress', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-current': { status: 'in_progress', comments: 'PLAN APPROVED\n\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'plan_approved',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=plan_approved')
    expect(context.message.content).toContain('bead=bead-current')
    expect(notifications).toEqual([])
  })


  it.each([
    'in_progress',
    'inreview',
    'simplified',
    'reviewed',
    'accepted',
    'custom_status',
  ])('keeps planning session and displays non-terminal bd status %s without lifecycle coercion', async (bdStatus) => {
    const { eventHandlers, ctx, statuses } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-current': { status: bdStatus, comments: 'PI_SESSION_KEY: id:session-current' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'planning',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'strict',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=planning')
    expect(context.message.content).toContain('bead=bead-current')
    expect(context.message.content).toContain(`bdStatus=${bdStatus}`)
    expect(statuses['workflow-state']).toContain('session:planning')
    expect(statuses['workflow-state']).toContain(`bd:${bdStatus}`)
  })

  it.each(['closed', 'blocked', 'deferred'])('clears active session binding for terminal bd status %s', async (bdStatus) => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-terminal': { status: bdStatus, comments: 'PI_SESSION_KEY: id:session-current' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'planning',
            activeBead: 'bead-terminal',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'strict',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    if (bdStatus === 'closed') {
      expect(context.message.content).toContain('state=closed')
      expect(context.message.content).toContain('sessionMode=closed')
    } else {
      expect(context.message.content).toContain('state=idle')
      expect(context.message.content).toContain('sessionMode=idle')
    }
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('bdStatus=-')
    expect(notifications.at(-1)?.message).toContain(`terminal bd status ${bdStatus}`)
  })

  it('keeps current runtime state when a later foreign runtime reset exists in the shared transcript', async () => {
    const { eventHandlers, ctx } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-current': { status: 'in_progress', comments: 'PI_SESSION_KEY: id:session-current' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'implementing',
            activeBead: 'bead-current',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            sessionKey: 'id:session-current',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'strict',
            mergeSlotHeld: true,
            updatedAt: new Date().toISOString(),
          },
        },
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'idle',
            runtimeOwnerKey: 'runtime:other-live-pane',
            planMode: 'off',
            mergeSlotHeld: false,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=implementing')
    expect(context.message.content).toContain('bead=bead-current')
    expect(context.message.content).toContain('plan=strict')
    expect(context.message.content).toContain('mergeSlot=held')
  })

  it('recovers a unique non-terminal bead from current branch/worktree comments without current-session marker', async () => {
    const { eventHandlers, ctx } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-foreign': { status: 'inreview', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/other\nWORKTREE: /repo/other\nSTART_COMMIT: old-head' },
        'bead-current': { status: 'inreview', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
      },
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=bead-current')
    expect(context.message.content).toContain('bdStatus=inreview')
    expect(context.message.content).not.toContain('bead=bead-foreign')
  })

  it('marks protected-branch non-terminal bead evidence as explicit unbound workflow state instead of silent bdStatus dash', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'main',
      worktreePath: '/repo',
      startCommit: 'main-head',
      issues: {
        'bead-current': { status: 'in_progress', comments: 'DISPATCH (test-supervisor)\n\nBRANCH: main\nWORKTREE: /repo\nSTART_COMMIT: main-head' },
      },
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('sessionMode=UNBOUND_WORKFLOW_STATE')
    expect(notifications.at(-1)?.message).toContain('UNBOUND_WORKFLOW_STATE')
  })

  it('marks current worktree evidence with a foreign session marker as explicit unbound workflow state', async () => {
    const { eventHandlers, ctx, notifications } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/worktrees/current',
      startCommit: 'task-head',
      issues: {
        'bead-current': { status: 'in_progress', comments: 'RUNTIME SMOKE SCOPE EVIDENCE\nBRANCH: task/current\nWORKTREE: /repo/worktrees/current\nSTART_COMMIT: task-head\nPI_SESSION_KEY: id:other-session' },
      },
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('sessionMode=UNBOUND_WORKFLOW_STATE')
    expect(notifications.at(-1)?.message).toContain('foreign session marker')
  })

  it('persists current runtime plan and slot changes from workflow-update without stale strict entries', async () => {
    const { eventHandlers, commandHandlers, ctx, appended, notifications, statuses } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {},
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'planning',
            branch: 'fix/current',
            worktreePath: '/repo/current',
            startCommit: 'current-head',
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            planMode: 'strict',
            mergeSlotHeld: true,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    await commandHandlers.get('workflow-update')?.handler('plan=off slot=free', ctx)

    expect(appended.at(-2)?.data).toMatchObject({ planMode: 'strict', mergeSlotHeld: true })
    expect(appended.at(-1)?.data).toMatchObject({ planMode: 'off', mergeSlotHeld: false })
    expect(notifications.at(-1)?.message).toContain('plan=off')
    expect(notifications.at(-1)?.message).toContain('mergeSlot=free')
    expect(statuses['workflow-state']).toContain('plan:off')
    expect(statuses['workflow-state']).toContain('slot:free')
  })

  it('persists sessionMode and planApproved from workflow-state:update events', async () => {
    const { eventHandlers, ctx, appended, statuses } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'bead-plan': { status: 'in_progress', comments: 'PI_SESSION_KEY: id:session-current\nBRANCH: fix/current\nWORKTREE: /repo/current\nSTART_COMMIT: current-head' },
      },
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    await eventHandlers.get('workflow-state:update')?.({
      ctx,
      state: 'implementing',
      activeBead: 'bead-plan',
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      planMode: 'off',
      planApproved: true,
      sessionMode: 'implementing',
    }, ctx)

    expect(appended.at(-1)?.data).toMatchObject({
      state: 'implementing',
      activeBead: 'bead-plan',
      planMode: 'off',
      planApproved: true,
      sessionMode: 'implementing',
      bdStatus: 'in_progress',
    })
    expect(statuses['workflow-state']).toContain('session:implementing')
    expect(statuses['workflow-state']).toContain('plan:off')
  })

  it('does not coerce plan-mode idle over implementing non-terminal activeBead', async () => {
    const { eventHandlers, ctx, appended } = makeHarness({
      branch: 'fix/dbtg-visible-cmux-cwd-state',
      worktreePath: '/repo/worktrees/dbtg-visible-cmux-cwd-state',
      startCommit: 'task-head',
      ctxCwd: '/repo/primary',
      gitScopes: {
        '/repo/worktrees/dbtg-visible-cmux-cwd-state': {
          branch: 'fix/dbtg-visible-cmux-cwd-state',
          worktreePath: '/repo/worktrees/dbtg-visible-cmux-cwd-state',
          startCommit: 'task-head',
        },
        '/repo/primary': { branch: 'main', worktreePath: '/repo/primary', startCommit: 'main-head' },
      },
      issues: {
        'bead-dbtg': { status: 'in_progress', comments: 'PI_SESSION_KEY: id:session-current\nBRANCH: fix/dbtg-visible-cmux-cwd-state\nWORKTREE: /repo/worktrees/dbtg-visible-cmux-cwd-state\nSTART_COMMIT: task-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'implementing',
            sessionMode: 'implementing',
            activeBead: 'bead-dbtg',
            branch: 'fix/dbtg-visible-cmux-cwd-state',
            worktreePath: '/repo/worktrees/dbtg-visible-cmux-cwd-state',
            startCommit: 'task-head',
            sessionKey: 'id:session-current',
            planMode: 'off',
            mergeSlotHeld: false,
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    await eventHandlers.get('workflow-state:update')?.({ ctx, planMode: 'off', sessionMode: 'idle' }, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=implementing')
    expect(context.message.content).toContain('bead=bead-dbtg')
    expect(context.message.content).toContain('worktree=/repo/worktrees/dbtg-visible-cmux-cwd-state')
    expect(context.message.content).not.toContain('state=idle')
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-dbtg', state: 'implementing', worktreePath: '/repo/worktrees/dbtg-visible-cmux-cwd-state' })
  })

  it('keyless ctx does not wipe valid recorded non-terminal task scope', async () => {
    const { eventHandlers, ctx, appended } = makeHarness({
      omitSessionKey: true,
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      gitScopes: {
        '/repo/worktrees/dbtg-visible-cmux-cwd-state': {
          branch: 'fix/dbtg-visible-cmux-cwd-state',
          worktreePath: '/repo/worktrees/dbtg-visible-cmux-cwd-state',
          startCommit: 'task-head',
        },
        '/repo/primary': { branch: 'main', worktreePath: '/repo/primary', startCommit: 'main-head' },
      },
      issues: {
        'bead-dbtg': { status: 'in_progress', comments: 'PI_SESSION_KEY: id:session-current\nBRANCH: fix/dbtg-visible-cmux-cwd-state\nWORKTREE: /repo/worktrees/dbtg-visible-cmux-cwd-state\nSTART_COMMIT: task-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'implementing',
            sessionMode: 'implementing',
            activeBead: 'bead-dbtg',
            branch: 'fix/dbtg-visible-cmux-cwd-state',
            worktreePath: '/repo/worktrees/dbtg-visible-cmux-cwd-state',
            startCommit: 'task-head',
            sessionKey: 'id:session-current',
            planMode: 'off',
            mergeSlotHeld: false,
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('bead=bead-dbtg')
    expect(context.message.content).toContain('state=implementing')
    expect(context.message.content).toContain('worktree=/repo/worktrees/dbtg-visible-cmux-cwd-state')
    expect(context.message.content).not.toContain('bead=-')
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-dbtg', state: 'implementing' })
  })

  it('recovers unsafe approved implementing state by current session ownership evidence', async () => {
    const { eventHandlers, ctx, appended } = makeHarness({
      branch: 'task/bead-plan',
      worktreePath: '/repo/worktrees/bead-plan',
      startCommit: 'task-head',
      issues: {
        'bead-plan': { status: 'in_progress', comments: 'PLAN APPROVED\nPI_SESSION_KEY: id:session-current\nBRANCH: task/bead-plan\nWORKTREE: /repo/worktrees/bead-plan\nSTART_COMMIT: task-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'idle',
            planMode: 'off',
            planApproved: true,
            sessionMode: 'implementing',
            mergeSlotHeld: false,
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=implementing')
    expect(context.message.content).toContain('bead=bead-plan')
    expect(context.message.content).toContain('branch=task/bead-plan')
    expect(context.message.content).toContain('worktree=/repo/worktrees/bead-plan')
    expect(context.message.content).toContain('start=task-head')
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-plan', state: 'implementing', planApproved: true, sessionMode: 'implementing' })
  })

  it('clears unsafe approved implementing state when same-session recovery candidate has foreign latest scope', async () => {
    const { eventHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'task/bead-plan',
      worktreePath: '/repo/worktrees/bead-plan',
      startCommit: 'task-head',
      issues: {
        'bead-foreign-scope': { status: 'in_progress', comments: 'PLAN APPROVED\nPI_SESSION_KEY: id:session-current\nBRANCH: task/other\nWORKTREE: /repo/worktrees/other\nSTART_COMMIT: other-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'idle',
            planMode: 'off',
            planApproved: true,
            sessionMode: 'implementing',
            mergeSlotHeld: false,
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('planApproved=false')
    expect(context.message.content).toContain('sessionMode=idle')
    expect(appended.at(-1)?.data).toMatchObject({ state: 'idle', planApproved: false, sessionMode: 'idle' })
    expect(notifications.at(-1)?.message).toContain('Небезопасное workflow-state')
  })

  it('clears unsafe approved implementing state and reports unbound when only foreign-session scope evidence remains', async () => {
    const { eventHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'task/bead-plan',
      worktreePath: '/repo/worktrees/bead-plan',
      startCommit: 'task-head',
      issues: {
        'bead-foreign': { status: 'in_progress', comments: 'PLAN APPROVED\nPI_SESSION_KEY: id:other-session\nBRANCH: task/bead-plan\nWORKTREE: /repo/worktrees/bead-plan\nSTART_COMMIT: task-head' },
      },
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: {
            state: 'idle',
            planMode: 'off',
            planApproved: true,
            sessionMode: 'implementing',
            mergeSlotHeld: false,
            runtimeOwnerKey: currentRuntimeOwnerKey(),
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('planApproved=false')
    expect(context.message.content).toContain('sessionMode=UNBOUND_WORKFLOW_STATE')
    expect(appended.at(-1)?.data).toMatchObject({ state: 'idle', planApproved: false, sessionMode: 'UNBOUND_WORKFLOW_STATE' })
    expect(notifications.at(-1)?.message).toContain('foreign session marker')
    expect(notifications.at(-1)?.message).toContain('восстановитесь через workflow_status/workflow_update/workflow_reset')
  })

  it('prevents workflow-update command from persisting approved implementing state without active bead', async () => {
    const { commandHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {},
    })

    await commandHandlers.get('workflow-update')?.handler('approved=true session=implementing', ctx)

    expect(appended.at(-1)?.data).toMatchObject({ planApproved: false, sessionMode: 'idle' })
    expect(notifications.at(-1)?.message).toContain('planApproved=false')
    expect(notifications.at(-1)?.message).toContain('sessionMode=idle')
  })

  it('claims natural-language claim-only intent but lets the agent continue for plan-mode decision', async () => {
    const { eventHandlers, ctx, appended, statuses, notifications } = makeHarness({
      branch: 'task/test',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'beads-task-issue-tracker-zzkb': { status: 'open', comments: '' },
      },
    })

    const result = await eventHandlers.get('input')?.({ source: 'user', text: 'заклейми beads-task-issue-tracker-zzkb' }, ctx)

    expect(result).toBeUndefined()
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'beads-task-issue-tracker-zzkb', state: 'claimed', planMode: 'off' })
    expect(statuses['workflow-state']).toContain('session:claimed')
    expect(statuses['workflow-state']).toContain('bead:beads-task-issue-tracker-zzkb')
    expect(notifications.at(-1)?.message).toContain('Claim выполнен для beads-task-issue-tracker-zzkb')
  })

  it('requires explicit current-session marker in comments for session ownership evidence', () => {
    expect(hasSessionOwnershipEvidence('DISPATCH\n\nBRANCH: fix/current', { branch: 'fix/current', sessionKey: 'id:session-current' })).toBe(false)
    expect(hasSessionOwnershipEvidence('DISPATCH\n\nPI_SESSION_KEY: id:session-current', { sessionKey: 'id:session-current' })).toBe(true)
    expect(hasSessionOwnershipEvidence('DISPATCH\n\nPI_SESSION_KEY: id:other', { sessionKey: 'id:session-current' })).toBe(false)
  })
})


describe('Pi workflow-state typed tools', () => {
  it('workflow_claim claims through bd and persists session-bound workflow state', async () => {
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: { 'bead-next': { status: 'open', comments: '' } },
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-next',
      state: 'claimed',
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      sessionKey: 'id:session-current',
      bdStatus: 'in_progress',
    })
  })

  it('workflow_claim from protected main does not record main as task scope and keeps PI_SESSION_KEY only', async () => {
    const { toolHandlers, ctx, appended, issues } = (() => {
      const issues = { 'bead-next': { status: 'open', comments: '' } }
      const harness = makeHarness({
        branch: 'main',
        worktreePath: '/repo',
        startCommit: 'main-head',
        ctxCwd: '/repo',
        issues,
      })
      return { ...harness, issues }
    })()

    const result = await toolHandlers.get('workflow_claim')?.execute('call-main', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-next',
      state: 'claimed',
      sessionKey: 'id:session-current',
      bdStatus: 'in_progress',
    })
    expect(appended.at(-1)?.data).toEqual(expect.objectContaining({
      branch: undefined,
      worktreePath: undefined,
      startCommit: undefined,
    }))
    expect(issues['bead-next'].comments).toContain('WORKFLOW CLAIM')
    expect(issues['bead-next'].comments).toContain('PI_SESSION_KEY: id:session-current')
    expect(issues['bead-next'].comments).not.toContain('BRANCH: main')
    expect(issues['bead-next'].comments).not.toContain('WORKTREE: /repo')
    expect(issues['bead-next'].comments).not.toContain('START_COMMIT: main-head')
  })

  it('reconcile keeps same-session claimed bead with empty task scope on main cwd instead of wiping', async () => {
    const { eventHandlers, toolHandlers, ctx, appended } = makeHarness({
      branch: 'main',
      worktreePath: '/repo',
      startCommit: 'main-head',
      ctxCwd: '/repo',
      issues: { 'bead-next': { status: 'in_progress', comments: 'WORKFLOW CLAIM\nPI_SESSION_KEY: id:session-current' } },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-next',
          state: 'planning',
          branch: undefined,
          worktreePath: undefined,
          startCommit: undefined,
          sessionKey: 'id:session-current',
          sessionMode: 'planning',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'strict',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    const status = await toolHandlers.get('workflow_status')?.execute('call-status', {}, undefined, undefined, ctx)

    expect(status.content[0].text).toContain('bead=bead-next')
    expect(status.content[0].text).not.toContain('bead=-')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-next',
      sessionKey: 'id:session-current',
    })
    expect((appended.at(-1)?.data as any).branch).toBeUndefined()
    expect((appended.at(-1)?.data as any).worktreePath).toBeUndefined()
  })

  it('workflow_claim allows claiming the same current-session active bead', async () => {
    const { eventHandlers, toolHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: { 'bead-current': { status: 'in_progress', comments: '' } },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-current',
          state: 'implementing',
          branch: 'task/current',
          worktreePath: '/repo/current',
          startCommit: 'start-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-current' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-current', state: 'claimed', bdStatus: 'in_progress' })
    expect(notifications.at(-1)?.message).toContain('Claim выполнен для bead-current')
  })

  it('workflow_claim recovers when bd claim leaves an already-assigned open bead open', async () => {
    const { toolHandlers, ctx, appended, notifications, execCalls } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: { 'bead-next': { status: 'open', comments: '' } },
      claimStatusById: { 'bead-next': 'open' },
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(execCalls).toEqual(expect.arrayContaining([
      { command: 'bd', args: ['update', 'bead-next', '--claim', '--json'] },
      { command: 'bd', args: ['update', 'bead-next', '--status', 'in_progress', '--json'] },
    ]))
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-next', state: 'claimed', bdStatus: 'in_progress' })
    expect(notifications.at(-1)?.message).toContain('Claim выполнен для bead-next')
  })

  it('workflow_claim fails without local claimed state when bd status remains open after claim fallback', async () => {
    const { toolHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: { 'bead-next': { status: 'open', comments: '' } },
      claimStatusById: { 'bead-next': 'open' },
      statusUpdateById: { 'bead-next': 'open' },
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim не выполнен для bead-next')
    expect(result.content[0].text).toContain('bdStatus=-')
    expect(result.content[0].text).toContain('reason: Failed to claim bead bead-next')
    expect(result.content[0].text).toContain('bd update bead-next --claim --json')
    expect(notifications.at(-1)?.message).toContain('bd status is open after command `bd update bead-next --claim --json`; expected in_progress')
    expect(appended.at(-1)?.data).toMatchObject({ state: 'idle' })
    expect((appended.at(-1)?.data as any).activeBead).toBeUndefined()
  })

  it('workflow_claim keeps newly claimed current-session state even when old comments have foreign ownership evidence', async () => {
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: { 'bead-next': { status: 'in_progress', comments: 'PLAN APPROVED\nPI_SESSION_KEY: id:old-session\nBRANCH: task/old\nWORKTREE: /repo/old\nSTART_COMMIT: old-head' } },
    })

    const claim = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)
    const status = await toolHandlers.get('workflow_status')?.execute('call-2', {}, undefined, undefined, ctx)

    expect(claim.content[0].text).toContain('workflow_claim выполнен')
    expect(status.content[0].text).toContain('bead=bead-next')
    expect(status.content[0].text).toContain('bdStatus=in_progress')
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-next', state: 'claimed', bdStatus: 'in_progress' })
  })

  it('workflow_claim fails instead of reporting completed when ownership evidence cannot be recorded', async () => {
    const { toolHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      commentAddCode: 1,
      issues: { 'bead-next': { status: 'in_progress', comments: 'PLAN APPROVED\nBRANCH: task/old\nWORKTREE: /repo/old' } },
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim не выполнен для bead-next')
    expect(result.content[0].text).toContain('bd comments add bead-next WORKFLOW CLAIM')
    expect(notifications.at(-1)?.message).toContain('Local workflow-state не изменён')
    expect((appended.at(-1)?.data as any).activeBead).toBeUndefined()
  })

  it('workflow_claim blocks unrelated claim when current-session active bead is in_progress', async () => {
    const { eventHandlers, toolHandlers, ctx, appended, notifications, execCalls } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: {
        'bead-current': { status: 'in_progress', comments: '' },
        'bead-next': { status: 'open', comments: '' },
      },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-current',
          state: 'implementing',
          branch: 'task/current',
          worktreePath: '/repo/current',
          startCommit: 'start-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim не выполнен для bead-next')
    expect(notifications.at(-1)?.message).toContain('non-terminal bd status in_progress')
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-current', state: 'implementing', bdStatus: 'in_progress' })
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args[1] === 'bead-next' && call.args.includes('--claim'))).toBe(false)
  })

  it('workflow_claim routes active inreview bead to review instead of unrelated claim', async () => {
    const { eventHandlers, toolHandlers, ctx, notifications, execCalls } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: {
        'bead-current': { status: 'inreview', comments: '' },
        'bead-next': { status: 'open', comments: '' },
      },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-current',
          state: 'inreview',
          branch: 'task/current',
          worktreePath: '/repo/current',
          startCommit: 'start-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim не выполнен для bead-next')
    expect(notifications.at(-1)?.message).toContain('запустите review-bead / review_bead')
    expect(notifications.at(-1)?.message).not.toContain(VISIBLE_REVIEW_DISPATCH)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args[1] === 'bead-next' && call.args.includes('--claim'))).toBe(false)
  })

  it('workflow_claim interactive hasUI routes inreview active bead to visible dispatch_reviewer', async () => {
    const { eventHandlers, toolHandlers, ctx, notifications, execCalls } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      hasUI: true,
      issues: {
        'bead-current': { status: 'inreview', comments: '' },
        'bead-next': { status: 'open', comments: '' },
      },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-current',
          state: 'inreview',
          branch: 'task/current',
          worktreePath: '/repo/current',
          startCommit: 'start-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim не выполнен для bead-next')
    expect(notifications.at(-1)?.message).toContain(VISIBLE_REVIEW_DISPATCH)
    expect(notifications.at(-1)?.message).toContain('headless-fallback')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args[1] === 'bead-next' && call.args.includes('--claim'))).toBe(false)
  })

  it('workflow_claim clears terminal active bead before claiming new work', async () => {
    const { eventHandlers, toolHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: {
        'bead-done': { status: 'closed', comments: '' },
        'bead-next': { status: 'open', comments: '' },
      },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-done',
          state: 'implementing',
          branch: 'task/current',
          worktreePath: '/repo/current',
          startCommit: 'start-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(notifications.some((notification) => notification.message.includes('terminal bd status closed'))).toBe(true)
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-next', state: 'claimed', sessionMode: 'claimed' })
  })

  it('workflow_complete(closed) then workflow_claim next writes sessionMode=claimed', async () => {
    const { eventHandlers, toolHandlers, ctx, appended } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: {
        'bead-done': { status: 'closed', comments: '' },
        'bead-next': { status: 'open', comments: '' },
      },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-done',
          state: 'implementing',
          sessionMode: 'implementing',
          branch: 'task/current',
          worktreePath: '/repo/current',
          startCommit: 'start-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const complete = await toolHandlers.get('workflow_complete')?.execute(
      'call-0',
      { state: 'closed', reason: 'accepted and closed' },
      undefined,
      undefined,
      ctx,
    )
    expect(complete.content[0].text).toContain('workflow_complete записал closed')
    expect(appended.at(-1)?.data).toMatchObject({
      state: 'closed',
      sessionMode: 'closed',
    })
    expect((appended.at(-1)?.data as any).activeBead).toBeUndefined()

    const claim = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)
    expect(claim.content[0].text).toContain('workflow_claim выполнен')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-next',
      state: 'claimed',
      sessionMode: 'claimed',
    })
  })

  it('workflow_claim recovers stale open active bead before claiming new work', async () => {
    const { eventHandlers, toolHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: {
        'bead-stale': { status: 'open', comments: 'BRANCH: task/foreign\nWORKTREE: /repo/foreign' },
        'bead-next': { status: 'open', comments: '' },
      },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-stale',
          state: 'implementing',
          branch: 'task/current',
          worktreePath: '/repo/current',
          startCommit: 'start-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'bead-next' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(notifications.some((notification) => notification.message.includes('stale or foreign'))).toBe(true)
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-next', state: 'claimed' })
  })

  it('workflow_claim from main binds a unique live canonical task worktree and keeps it after reconcile', async () => {
    const taskPath = path.join(WORKTREE_ROOT, 'xy73-claim-existing-worktree-deadlock')
    const taskBranch = 'fix/xy73-claim-existing-worktree-deadlock'
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      issues: { 'beads-task-issue-tracker-xy73': { status: 'open', comments: '' } },
      worktreePorcelain: {
        code: 0,
        stdout: [
          'worktree /repo/primary',
          'HEAD main-head',
          'branch refs/heads/main',
          '',
          `worktree ${taskPath}`,
          'HEAD task-head',
          `branch refs/heads/${taskBranch}`,
          '',
        ].join('\n'),
      },
      gitScopes: {
        '/repo/primary': { branch: 'main', worktreePath: '/repo/primary', startCommit: 'main-head' },
        [taskPath]: { branch: taskBranch, worktreePath: taskPath, startCommit: 'task-head' },
      },
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'beads-task-issue-tracker-xy73' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(result.content[0].text).toContain(`worktree=${taskPath}`)
    expect(result.content[0].text).not.toContain('worktree=/repo/primary')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'beads-task-issue-tracker-xy73',
      state: 'claimed',
      branch: taskBranch,
      worktreePath: taskPath,
      startCommit: 'task-head',
      sessionKey: 'id:session-current',
      bdStatus: 'in_progress',
    })

    const status = await toolHandlers.get('workflow_status')?.execute('call-2', {}, undefined, undefined, ctx)
    expect(status.content[0].text).toContain(`worktree=${taskPath}`)
    expect(status.content[0].text).toContain(`branch=${taskBranch}`)
    expect(status.content[0].text).not.toContain('branch=main')
  })

  it('workflow_claim from main with zero porcelain matches persists cwd as today', async () => {
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      issues: { 'beads-task-issue-tracker-xy73': { status: 'open', comments: '' } },
      worktreePorcelain: { code: 0, stdout: '' },
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'beads-task-issue-tracker-xy73' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'beads-task-issue-tracker-xy73',
      state: 'claimed',
      branch: undefined,
      worktreePath: undefined,
      startCommit: undefined,
      bdStatus: 'in_progress',
    })
  })

  it('workflow_claim from main with ambiguous porcelain keeps claimed empty scope and does not lock main', async () => {
    const first = path.join(WORKTREE_ROOT, 'xy73-claim-existing-worktree-deadlock')
    const second = path.join(WORKTREE_ROOT, 'xy73-other-purpose')
    const { toolHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      issues: { 'beads-task-issue-tracker-xy73': { status: 'open', comments: '' } },
      worktreePorcelain: {
        code: 0,
        stdout: [
          `worktree ${first}`,
          'HEAD one-head',
          'branch refs/heads/fix/xy73-claim-existing-worktree-deadlock',
          '',
          `worktree ${second}`,
          'HEAD two-head',
          'branch refs/heads/fix/xy73-other-purpose',
          '',
        ].join('\n'),
      },
      gitScopes: {
        '/repo/primary': { branch: 'main', worktreePath: '/repo/primary', startCommit: 'main-head' },
        [first]: { branch: 'fix/xy73-claim-existing-worktree-deadlock', worktreePath: first, startCommit: 'one-head' },
        [second]: { branch: 'fix/xy73-other-purpose', worktreePath: second, startCommit: 'two-head' },
      },
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'beads-task-issue-tracker-xy73' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(result.content[0].text).toContain('workflow_update')
    expect(result.details.ok).toBe(true)
    expect(result.details.worktreePath).toBeUndefined()
    expect(result.details.branch).toBeUndefined()
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'beads-task-issue-tracker-xy73',
      state: 'claimed',
      sessionKey: 'id:session-current',
      bdStatus: 'in_progress',
    })
    expect(appended.at(-1)?.data).not.toMatchObject({ worktreePath: '/repo/primary' })
    expect(appended.at(-1)?.data).not.toMatchObject({ branch: 'main' })
    expect(notifications.some((item) => item.level === 'warning' && item.message.includes('workflow_update'))).toBe(true)

    const status = await toolHandlers.get('workflow_status')?.execute('call-2', {}, undefined, undefined, ctx)
    expect(status.content[0].text).toContain('bead=beads-task-issue-tracker-xy73')
    expect(status.content[0].text).toContain('state=claimed')
    expect(status.content[0].text).toContain('worktree=-')
    expect(status.content[0].text).not.toContain('worktree=/repo/primary')
  })

  it('workflow_claim from main with porcelain list fail keeps claimed empty scope', async () => {
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      issues: { 'beads-task-issue-tracker-xy73': { status: 'open', comments: '' } },
      worktreePorcelain: { code: 1, stdout: '', stderr: 'list failed' },
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'beads-task-issue-tracker-xy73' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(result.details.ok).toBe(true)
    expect(result.details.worktreePath).toBeUndefined()
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'beads-task-issue-tracker-xy73',
      state: 'claimed',
      sessionKey: 'id:session-current',
      bdStatus: 'in_progress',
    })
    expect((appended.at(-1)?.data as any).worktreePath).toBeUndefined()
    expect((appended.at(-1)?.data as any).branch).toBeUndefined()

    const status = await toolHandlers.get('workflow_status')?.execute('call-2', {}, undefined, undefined, ctx)
    expect(status.content[0].text).toContain('state=claimed')
    expect(status.content[0].text).toContain('worktree=-')
  })

  it('workflow_claim from main ignores dead porcelain path and falls back to cwd', async () => {
    const deadPath = path.join(WORKTREE_ROOT, 'xy73-claim-existing-worktree-deadlock')
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      issues: { 'beads-task-issue-tracker-xy73': { status: 'open', comments: '' } },
      worktreePorcelain: {
        code: 0,
        stdout: [
          `worktree ${deadPath}`,
          'HEAD dead-head',
          'branch refs/heads/fix/xy73-claim-existing-worktree-deadlock',
          '',
        ].join('\n'),
      },
      // no gitScopes entry for deadPath → live checks fail
    })

    const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'beads-task-issue-tracker-xy73' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_claim выполнен')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'beads-task-issue-tracker-xy73',
      state: 'claimed',
      branch: undefined,
      worktreePath: undefined,
      startCommit: undefined,
    })
  })

  it('workflow_update persists a complete explicit typed update without cwd reconciliation overwriting task fields', async () => {
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      issues: { 'bead-task': { status: 'in_progress', comments: '' } },
    })

    const result = await toolHandlers.get('workflow_update')?.execute('call-1', {
      bead: 'bead-task',
      state: 'implementing',
      branch: 'task/bead-task',
      worktree: '/repo/worktrees/bead-task',
      start: 'task-start',
      end: 'task-end',
      approved: false,
      session: 'implementing',
      slot: 'free',
    }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('branch=task/bead-task')
    expect(result.content[0].text).toContain('worktree=/repo/worktrees/bead-task')
    expect(result.content[0].text).toContain('planApproved=false')
    expect(result.content[0].text).toContain('sessionMode=implementing')
    expect(result.content[0].text).toContain('mergeSlot=free')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-task',
      state: 'implementing',
      branch: 'task/bead-task',
      worktreePath: '/repo/worktrees/bead-task',
      startCommit: 'task-start',
      endCommit: 'task-end',
      planApproved: false,
      sessionMode: 'implementing',
      mergeSlotHeld: false,
      sessionKey: 'id:session-current',
      bdStatus: 'in_progress',
    })
  })

  it('workflow_update clears unsafe approved implementing state even with explicit typed scope', async () => {
    const { toolHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'task/bead-plan',
      worktreePath: '/repo/worktrees/bead-plan',
      startCommit: 'task-head',
      ctxCwd: '/repo/worktrees/bead-plan',
      issues: {},
    })

    const result = await toolHandlers.get('workflow_update')?.execute('call-1', {
      state: 'implementing',
      branch: 'task/bead-plan',
      worktree: '/repo/worktrees/bead-plan',
      start: 'task-head',
      approved: true,
      session: 'implementing',
    }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('state=idle')
    expect(result.content[0].text).toContain('bead=-')
    expect(result.content[0].text).toContain('planApproved=false')
    expect(result.content[0].text).toContain('sessionMode=idle')
    expect(appended.at(-1)?.data).toMatchObject({ state: 'idle', planApproved: false, sessionMode: 'idle' })
    expect(notifications.at(-1)?.message).toContain('Небезопасное workflow-state')
  })

  it('workflow_update records a task worktree over an existing main checkout session context', async () => {
    const { eventHandlers, toolHandlers, ctx, appended, statuses } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      gitScopes: { '/repo/worktrees/bead-task': { branch: 'task/bead-task', worktreePath: '/repo/worktrees/bead-task', startCommit: 'task-head' } },
      issues: { 'bead-task': { status: 'in_progress', comments: 'BRANCH: main\nWORKTREE: /repo/primary' } },
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    await toolHandlers.get('workflow_update')?.execute('call-1', {
      bead: 'bead-task',
      state: 'implementing',
      branch: 'task/bead-task',
      worktree: '/repo/worktrees/bead-task',
      start: 'task-head',
    }, undefined, undefined, ctx)
    const status = await toolHandlers.get('workflow_status')?.execute('call-2', {}, undefined, undefined, ctx)

    expect(status.content[0].text).toContain('branch=task/bead-task')
    expect(status.content[0].text).toContain('worktree=/repo/worktrees/bead-task')
    expect(status.content[0].text).not.toContain('branch=main')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-task',
      branch: 'task/bead-task',
      worktreePath: '/repo/worktrees/bead-task',
      startCommit: 'task-head',
    })
    expect(statuses['workflow-state']).toContain('br:task/bead-task')
  })

  it('workflow_update recovers an inreview bead to the task worktree review state from stale main context', async () => {
    const { eventHandlers, toolHandlers, ctx, appended } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      gitScopes: { '/repo/worktrees/bead-task': { branch: 'task/bead-task', worktreePath: '/repo/worktrees/bead-task', startCommit: 'task-head' } },
      issues: { 'bead-task': { status: 'inreview', comments: 'WORKFLOW CLAIM\nBRANCH: main\nWORKTREE: /repo/primary\nPI_SESSION_KEY: id:session-current' } },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-task',
          state: 'idle',
          branch: 'main',
          worktreePath: '/repo/primary',
          startCommit: 'main-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const result = await toolHandlers.get('workflow_update')?.execute('call-1', {
      bead: 'bead-task',
      state: 'reviewing',
      session: 'reviewing',
      branch: 'task/bead-task',
      worktree: '/repo/worktrees/bead-task',
      start: 'task-head',
      end: 'task-end',
    }, undefined, undefined, ctx)
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(result.content[0].text).toContain('state=reviewing')
    expect(result.content[0].text).toContain('branch=task/bead-task')
    expect(result.content[0].text).toContain('worktree=/repo/worktrees/bead-task')
    expect(result.content[0].text).toContain('sessionMode=reviewing')
    expect(result.content[0].text).toContain('bdStatus=inreview')
    expect(context.message.content).toContain('[PI INREVIEW GUARD]')
    expect(context.message.content).toContain('review-bead / review_bead')
    expect(context.message.content).not.toContain(VISIBLE_REVIEW_DISPATCH)
    expect(context.message.content).toContain('Не заявляй, что review_bead или dispatch_reviewer недоступны')
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'bead-task', state: 'reviewing', sessionMode: 'reviewing', branch: 'task/bead-task', worktreePath: '/repo/worktrees/bead-task', bdStatus: 'inreview' })
  })

  it('workflow_update rejects invalid typed parameters without resetting state', async () => {
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      issues: {},
    })

    const result = await toolHandlers.get('workflow_update')?.execute('call-1', { state: 'not-a-state', slot: 'busy' } as any, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_update отклонён')
    expect(result.details).toMatchObject({ ok: false, error: 'Invalid state: not-a-state', state: 'idle' })
    expect(appended).toHaveLength(0)
  })

  it('workflow_update reports a no-op reason when no parameters are provided', async () => {
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      issues: {},
    })

    const result = await toolHandlers.get('workflow_update')?.execute('call-1', {}, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('workflow_update no-op: supported parameters не переданы')
    expect(result.details).toMatchObject({ ok: true, reason: 'no supported parameters provided', state: 'idle' })
    expect(appended).toHaveLength(0)
  })

  it('workflow_submit_for_review from main preserves explicit task worktree review scope and records durable evidence', async () => {
    const { toolHandlers, ctx, appended, execCalls } = makeHarness({
      branch: 'main',
      worktreePath: '/repo/primary',
      startCommit: 'main-head',
      ctxCwd: '/repo/primary',
      gitScopes: { '/repo/worktrees/bead-task': { branch: 'task/bead-task', worktreePath: '/repo/worktrees/bead-task', startCommit: 'task-head' } },
      issues: { 'bead-task': { status: 'in_progress', comments: 'WORKFLOW CLAIM\nBRANCH: task/bead-task\nWORKTREE: /repo/worktrees/bead-task\nSTART_COMMIT: task-head\nPI_SESSION_KEY: id:session-current' } },
    })

    await toolHandlers.get('workflow_update')?.execute('call-1', {
      bead: 'bead-task',
      state: 'implementing',
      session: 'implementing',
      branch: 'task/bead-task',
      worktree: '/repo/worktrees/bead-task',
      start: 'task-head',
    }, undefined, undefined, ctx)

    const result = await toolHandlers.get('workflow_submit_for_review')?.execute(
      'call-2',
      { beadId: 'bead-task', reason: 'tests passed', endCommit: 'task-end' },
      undefined,
      undefined,
      ctx,
    )

    expect(result.content[0].text).toContain('branch=task/bead-task')
    expect(result.content[0].text).toContain('worktree=/repo/worktrees/bead-task')
    expect(result.content[0].text).not.toContain('branch=main')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-task',
      state: 'inreview',
      sessionMode: 'inreview',
      branch: 'task/bead-task',
      worktreePath: '/repo/worktrees/bead-task',
      startCommit: 'task-head',
      endCommit: 'task-end',
      bdStatus: 'inreview',
    })
    const commentAdd = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && call.args[2] === 'bead-task' && call.args[3]?.includes('WORKFLOW SUBMIT FOR REVIEW'))
    expect(commentAdd?.args[3]).toContain('WORKFLOW SUBMIT FOR REVIEW')
    expect(commentAdd?.args[3]).toContain('BRANCH: task/bead-task')
    expect(commentAdd?.args[3]).toContain('WORKTREE: /repo/worktrees/bead-task')
    expect(commentAdd?.args[3]).toContain('START_COMMIT: task-head')
    expect(commentAdd?.args[3]).toContain('END_COMMIT: task-end')
  })

  it('workflow_submit_for_review syncs bd inreview and exposes review guard', async () => {
    const { toolHandlers, eventHandlers, ctx, appended, execCalls } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: { 'bead-current': { status: 'in_progress', comments: '' } },
    })

    const result = await toolHandlers.get('workflow_submit_for_review')?.execute(
      'call-1',
      { beadId: 'bead-current', reason: 'tests passed', endCommit: 'end-head' },
      undefined,
      undefined,
      ctx,
    )
    const context = await eventHandlers.get('before_agent_start')?.({}, ctx) as any

    expect(result.content[0].text).toContain('workflow_submit_for_review выполнен')
    expect(result.content[0].text).toContain(VISIBLE_REVIEW_DISPATCH)
    expect(result.content[0].text).toContain('transport=cmux')
    expect(result.content[0].text).toContain('headless-fallback')
    expect(result.content[0].text).toContain('review_bead')
    expect(result.content[0].text.indexOf('dispatch_reviewer')).toBeLessThan(result.content[0].text.indexOf('review_bead — только headless-fallback'))
    expect(execCalls.some((call) => call.command === 'bd' && call.args.join(' ') === 'update bead-current --status inreview --json')).toBe(true)
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-current',
      state: 'inreview',
      sessionMode: 'inreview',
      bdStatus: 'inreview',
      endCommit: 'end-head',
    })
    expect(context.message.content).toContain('[PI INREVIEW GUARD]')
    expect(context.message.content).toContain('review-bead / review_bead')
    expect(context.message.content).not.toContain(VISIBLE_REVIEW_DISPATCH)
    expect(context.message.content).toContain('typed call вернул ошибку до запуска review')
  })

  it('workflow_complete blocks active inreview normal completion but allows explicit blocker', async () => {
    const { eventHandlers, toolHandlers, ctx, appended } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: { 'bead-current': { status: 'inreview', comments: '' } },
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-current',
          state: 'implementing',
          sessionMode: 'implementing',
          branch: 'task/current',
          worktreePath: '/repo/current',
          startCommit: 'start-head',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
          planMode: 'off',
          mergeSlotHeld: false,
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    await eventHandlers.get('session_start')?.({}, ctx)

    const blocked = await toolHandlers.get('workflow_complete')?.execute('call-1', { state: 'closed', reason: 'done' }, undefined, undefined, ctx)
    const explicitBlocker = await toolHandlers.get('workflow_complete')?.execute('call-2', { state: 'blocked', reason: 'review_bead tool unavailable' }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_complete заблокирован')
    expect(blocked.content[0].text).toContain(VISIBLE_REVIEW_DISPATCH)
    expect(blocked.content[0].text).toContain('transport=cmux')
    expect(blocked.content[0].text).toContain('headless-fallback')
    expect(blocked.content[0].text).toContain('review_bead')
    expect(blocked.content[0].text.indexOf('dispatch_reviewer')).toBeLessThan(blocked.content[0].text.indexOf('review_bead — только headless-fallback'))
    expect(blocked.details).toMatchObject({ ok: false, activeBead: 'bead-current', state: 'inreview', sessionMode: 'inreview', bdStatus: 'inreview' })
    expect(explicitBlocker.content[0].text).toContain('workflow_complete записал blocked')
    expect(appended.at(-1)?.data).toMatchObject({ state: 'blocked', sessionMode: 'blocked' })
  })

  it('workflow_update reconciles stale open active bead instead of dead-ending new claims', async () => {
    const { toolHandlers, ctx, appended } = makeHarness({
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      ctxCwd: '/repo/current',
      issues: { 'bead-old': { status: 'open', comments: 'BRANCH: task/foreign\nWORKTREE: /repo/foreign' } },
    })

    const result = await toolHandlers.get('workflow_update')?.execute('call-1', { bead: 'bead-old', state: 'implementing' }, undefined, undefined, ctx)

    expect(result.content[0].text).toContain('state=idle')
    expect(appended.at(-1)?.data).toMatchObject({ state: 'idle' })
    expect((appended.at(-1)?.data as any).activeBead).toBeUndefined()
  })

  it('does not auto-bind tracker copies when copyRequired is false and copyRoot is omitted', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'wf-state-chains-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
    mkdirSync(path.join(repo, '.pi', 'config'), { recursive: true })
    writeFileSync(path.join(repo, '.pi', 'config', 'workflow-chains.json'), `${JSON.stringify({
      copyRequired: false,
      handoffFromCopy: false,
      naming: {
        types: ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'ci', 'task'],
        basenameEqualsBranchSuffix: true,
        suffixMustNotStartWith: 'beads-task-issue-tracker-',
        suffixPattern: '^[a-z0-9]+-[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*$',
        requireActiveBeadSuffixPrefix: true,
      },
    }, null, 2)}\n`)
    const taskPath = path.join(WORKTREE_ROOT, 'xy73-claim-existing-worktree-deadlock')
    const taskBranch = 'fix/xy73-claim-existing-worktree-deadlock'
    try {
      const { toolHandlers, ctx, appended } = makeHarness({
        branch: 'main',
        worktreePath: repo,
        startCommit: 'main-head',
        ctxCwd: repo,
        issues: { 'beads-task-issue-tracker-xy73': { status: 'open', comments: '' } },
        worktreePorcelain: {
          code: 0,
          stdout: [
            `worktree ${repo}`,
            'HEAD main-head',
            'branch refs/heads/main',
            '',
            `worktree ${taskPath}`,
            'HEAD task-head',
            `branch refs/heads/${taskBranch}`,
            '',
          ].join('\n'),
        },
        gitScopes: {
          [repo]: { branch: 'main', worktreePath: repo, startCommit: 'main-head' },
          [taskPath]: { branch: taskBranch, worktreePath: taskPath, startCommit: 'task-head' },
        },
      })

      const result = await toolHandlers.get('workflow_claim')?.execute('call-1', { beadId: 'beads-task-issue-tracker-xy73' }, undefined, undefined, ctx)

      expect(result.content[0].text).toContain('workflow_claim выполнен')
      expect(result.content[0].text).not.toContain(`worktree=${taskPath}`)
      expect(appended.at(-1)?.data).toMatchObject({
        activeBead: 'beads-task-issue-tracker-xy73',
        state: 'claimed',
      })
      expect((appended.at(-1)?.data as any).worktreePath).not.toBe(taskPath)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
