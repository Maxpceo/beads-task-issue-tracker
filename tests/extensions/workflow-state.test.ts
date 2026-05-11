import { describe, expect, it } from 'vitest'

import workflowStateExtension, { hasSessionOwnershipEvidence } from '../../.pi/extensions/workflow-state/index'

function makeHarness(options: {
  branch: string
  worktreePath: string
  startCommit: string
  issues: Record<string, { status: string; comments: string }>
  entries?: Array<{ type: string; customType?: string; data?: unknown }>
  sessionKey?: string
  ctxCwd?: string
  processBranch?: string
  processWorktreePath?: string
  processStartCommit?: string
}) {
  const eventHandlers = new Map<string, (event: unknown, ctx: any) => unknown>()
  const commandHandlers = new Map<string, any>()
  const appended: Array<{ type: string; data: unknown }> = []
  const notifications: Array<{ message: string; level?: string }> = []

  const processBranch = options.processBranch ?? options.branch
  const processWorktreePath = options.processWorktreePath ?? options.worktreePath
  const processStartCommit = options.processStartCommit ?? options.startCommit

  const pi: any = {
    exec: async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === '-C' && args[1] === options.ctxCwd) {
        const scopedArgs = args.slice(2).join(' ')
        if (scopedArgs === 'branch --show-current') return { stdout: `${options.branch}\n`, stderr: '', code: 0 }
        if (scopedArgs === 'rev-parse HEAD') return { stdout: `${options.startCommit}\n`, stderr: '', code: 0 }
        if (scopedArgs === 'rev-parse --show-toplevel') return { stdout: `${options.worktreePath}\n`, stderr: '', code: 0 }
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
      if (command === 'bd' && args[0] === 'comments') {
        const id = args[1] ?? ''
        return { stdout: options.issues[id]?.comments ?? '', stderr: '', code: options.issues[id] ? 0 : 1 }
      }
      if (command === 'bd' && args[0] === 'show') {
        const id = args[1] ?? ''
        const issue = options.issues[id]
        return { stdout: JSON.stringify(issue ? { id, status: issue.status } : {}), stderr: '', code: issue ? 0 : 1 }
      }
      return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
    },
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    events: { on: (name: string, handler: (event: unknown, ctx: any) => unknown) => eventHandlers.set(name, handler) },
    on: (name: string, handler: (event: unknown, ctx: any) => unknown) => eventHandlers.set(name, handler),
    registerCommand: (name: string, config: any) => commandHandlers.set(name, config),
  }

  const ctx: any = {
    cwd: options.ctxCwd,
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionId: () => options.sessionKey ?? 'session-current',
    },
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }), setStatus: () => undefined, theme: { fg: (_style: string, value: string) => value } },
  }

  workflowStateExtension(pi)

  return { eventHandlers, commandHandlers, ctx, appended, notifications }
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
    expect(notifications.at(-1)?.message).toContain('stale or foreign')
    expect(notifications.at(-1)?.message).toContain('/workflow-reset')
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
    expect(notifications.at(-1)?.message).toContain('stale or foreign')
  })

  it('clears restored active bead when bd status is closed even if local workflow state is non-terminal', async () => {
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
    expect(context.message.content).not.toContain('state=implementing')
    expect(context.message.content).not.toContain('bead=bead-closed')
    expect(notifications.at(-1)?.message).toContain('terminal bd status closed')
  })

  it('clears restored active bead when bd status is closed even if local workflow state is already terminal', async () => {
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

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('end=-')
    expect(context.message.content).not.toContain('state=closed')
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
    expect(notifications.at(-1)?.message).toContain('state=idle')
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
    expect(appended.at(-1)?.data).toMatchObject({ state: 'idle' })
    expect((appended.at(-1)?.data as any).activeBead).toBeUndefined()
    expect((appended.at(-1)?.data as any).endCommit).toBeUndefined()
    expect(notifications.at(-2)?.message).toContain('terminal bd status closed')
    expect(notifications.at(-1)?.message).toContain('state=idle')
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

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).toContain('end=-')
    expect(context.message.content).not.toContain('state=reviewing')
    expect(context.message.content).not.toContain('bead=bead-closed')
    expect(notifications.at(-1)?.message).toContain('terminal bd status closed')
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

  it('reconciles restored active bead with bd inreview status for footer context', async () => {
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
    expect(context.message.content).not.toContain('state=implementing')
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

  it('reconciles a same-session inreview workflow state when bd status moved back to in_progress', async () => {
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
    expect(notifications.at(-1)?.message).toContain('not launching review from stale local state')
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

  it('does not recover global inreview beads from branch/worktree comments without current-session marker', async () => {
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
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).not.toContain('bead=bead-current')
    expect(context.message.content).not.toContain('bead=bead-foreign')
  })

  it('requires explicit current-session marker in comments for session ownership evidence', () => {
    expect(hasSessionOwnershipEvidence('DISPATCH\n\nBRANCH: fix/current', { branch: 'fix/current', sessionKey: 'id:session-current' })).toBe(false)
    expect(hasSessionOwnershipEvidence('DISPATCH\n\nPI_SESSION_KEY: id:session-current', { sessionKey: 'id:session-current' })).toBe(true)
    expect(hasSessionOwnershipEvidence('DISPATCH\n\nPI_SESSION_KEY: id:other', { sessionKey: 'id:session-current' })).toBe(false)
  })
})
