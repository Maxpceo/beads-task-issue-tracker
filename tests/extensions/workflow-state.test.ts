import { describe, expect, it } from 'vitest'

import workflowStateExtension, { currentRuntimeOwnerKey, hasSessionOwnershipEvidence } from '../../.pi/extensions/workflow-state/index'

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
  const toolHandlers = new Map<string, any>()
  const appended: Array<{ type: string; data: unknown }> = []
  const notifications: Array<{ message: string; level?: string }> = []
  const statuses: Record<string, string | undefined> = {}

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
      if (command === 'bd' && args[0] === 'update' && args.includes('--claim')) {
        const id = args[1] ?? ''
        const issue = options.issues[id]
        return { stdout: JSON.stringify(issue ? { id, status: 'in_progress' } : {}), stderr: '', code: issue ? 0 : 1 }
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
      getSessionId: () => options.sessionKey ?? 'session-current',
    },
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }), setStatus: (key: string, value: string | undefined) => { statuses[key] = value }, theme: { fg: (_style: string, value: string) => value } },
  }

  workflowStateExtension(pi)

  return { eventHandlers, commandHandlers, toolHandlers, ctx, appended, notifications, statuses }
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
    expect(notifications).toEqual([])
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

    expect(context.message.content).toContain('state=idle')
    expect(context.message.content).toContain('bead=-')
    expect(context.message.content).not.toContain('state=implementing')
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

  it('keeps restored session context and displays live bd inreview status for footer context', async () => {
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

    expect(context.message.content).toContain('state=implementing')
    expect(context.message.content).toContain('bead=bead-current')
    expect(context.message.content).toContain('bdStatus=inreview')
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
  ])('keeps session mode and displays non-terminal bd status %s without lifecycle coercion', async (bdStatus) => {
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

    expect(context.message.content).toContain('state=idle')
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
      issues: {},
    })

    await eventHandlers.get('session_start')?.({}, ctx)
    await eventHandlers.get('workflow-state:update')?.({
      ctx,
      activeBead: 'bead-plan',
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      planMode: 'off',
      planApproved: true,
      sessionMode: 'implementing',
    }, ctx)

    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-plan',
      planMode: 'off',
      planApproved: true,
      sessionMode: 'implementing',
    })
    expect(statuses['workflow-state']).toContain('plan:off')
  })

  it('updates planApproved and session mode through workflow-update command', async () => {
    const { commandHandlers, ctx, appended, notifications } = makeHarness({
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {},
    })

    await commandHandlers.get('workflow-update')?.handler('approved=true session=implementing', ctx)

    expect(appended.at(-1)?.data).toMatchObject({ planApproved: true, sessionMode: 'implementing' })
    expect(notifications.at(-1)?.message).toContain('planApproved=true')
    expect(notifications.at(-1)?.message).toContain('sessionMode=implementing')
  })

  it('handles natural-language claim-only intent with an explicit bead id', async () => {
    const { eventHandlers, ctx, appended, statuses, notifications } = makeHarness({
      branch: 'task/test',
      worktreePath: '/repo/current',
      startCommit: 'current-head',
      issues: {
        'beads-task-issue-tracker-zzkb': { status: 'open', comments: '' },
      },
    })

    const result = await eventHandlers.get('input')?.({ source: 'user', text: 'заклейми beads-task-issue-tracker-zzkb' }, ctx)

    expect(result).toEqual({ action: 'handled' })
    expect(appended.at(-1)?.data).toMatchObject({ activeBead: 'beads-task-issue-tracker-zzkb', state: 'claimed', planMode: 'off' })
    expect(statuses['workflow-state']).toContain('session:claimed')
    expect(statuses['workflow-state']).toContain('bead:beads-task-issue-tracker-zzkb')
    expect(notifications.at(-1)?.message).toContain('Claimed beads-task-issue-tracker-zzkb')
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

    expect(result.content[0].text).toContain('workflow_claim completed')
    expect(appended.at(-1)?.data).toMatchObject({
      activeBead: 'bead-next',
      state: 'claimed',
      branch: 'task/current',
      worktreePath: '/repo/current',
      startCommit: 'start-head',
      sessionKey: 'id:session-current',
    })
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
})
