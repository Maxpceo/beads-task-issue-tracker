import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

import { registerWorkflowClaimApi, requestWorkflowClaim } from '../../.pi/extensions/workflow-state/index'
import { parseWorkflowIntent, shouldAutoClaimAndPlan } from '../../.pi/extensions/workflow-intent/index'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions/plan-mode/index.ts'), 'utf8')

function loadPlanModeExtension(): (pi: unknown) => void {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} as { default?: (pi: unknown) => void } }
  const mockRequire = (id: string) => {
    if (id === '@earendil-works/pi-tui') return { Key: { ctrlAlt: (key: string) => `ctrlAlt:${key}` } }
    if (id === './utils.js') {
      return {
        extractTodoItems: () => [],
        isSafeCommand: (command: string) => !command.includes('rm -rf'),
        markCompletedSteps: (items: unknown[]) => items,
        validateAutoExecutePlan: () => ({ valid: true, reason: '' }),
      }
    }
    if (id === '../workflow-state/index') return { requestWorkflowClaim }
    if (id === '../workflow-intent/index') return { parseWorkflowIntent, shouldAutoClaimAndPlan }
    if (id === '@earendil-works/pi-agent-core' || id === '@earendil-works/pi-ai' || id === '@earendil-works/pi-coding-agent') return {}
    throw new Error(`Unexpected require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(mockRequire, module, module.exports)
  if (!module.exports.default) throw new Error('plan-mode default export not loaded')
  return module.exports.default
}

function makeHarness(options: { activeStatus?: 'in_progress' | 'inreview' } = {}) {
  const commandHandlers = new Map<string, { handler: (args: string, ctx: any) => unknown }>()
  const toolHandlers = new Map<string, any>()
  const workflowUpdates: unknown[] = []
  const statuses: Record<string, string | undefined> = {}
  const widgets: Record<string, string[] | undefined> = {}
  const activeTools: string[][] = []
  const inputHandlers: Array<(event: any, ctx: any) => unknown> = []
  const toolCallHandlers: Array<(event: any, ctx: any) => unknown> = []
  const execCalls: Array<{ command: string, args: string[] }> = []
  const delayedClaimEvents: unknown[] = []

  const pi: any = {
    registerFlag() {},
    registerCommand: (name: string, config: { handler: (args: string, ctx: any) => unknown }) => commandHandlers.set(name, config),
    registerTool: (tool: any) => toolHandlers.set(tool.name, tool),
    registerShortcut() {},
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      if (event === 'input') inputHandlers.push(handler)
      if (event === 'tool_call') toolCallHandlers.push(handler)
    },
    appendEntry() {},
    setActiveTools: (tools: string[]) => activeTools.push(tools),
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'bd' && args[0] === 'show') return { stdout: '[{"id":"beads-task-issue-tracker-zzkb","status":"open"}]', stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'update') return { stdout: '[{"id":"beads-task-issue-tracker-zzkb","status":"in_progress"}]', stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '{"ok":true}', stderr: '', code: 0 }
      if (command === 'git' && args.includes('branch')) return { stdout: 'task/test\n', stderr: '', code: 0 }
      if (command === 'git' && args.includes('--show-toplevel')) return { stdout: '/tmp/project\n', stderr: '', code: 0 }
      if (command === 'git' && args.includes('HEAD')) return { stdout: 'abc123\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    },
    events: {
      emit: (name: string, event: any) => {
        if (name === 'workflow-state:update') workflowUpdates.push(event)
        if (name === 'workflow-state:claim') {
          void Promise.resolve().then(() => {
            delayedClaimEvents.push(event)
            event.result = { ok: false, state: { activeBead: 'late-handler' } }
          })
        }
      },
    },
  }
  const ctx: any = {
    cwd: '/tmp/project',
    sessionManager: { getSessionId: () => 'session-current' },
    hasUI: true,
    ui: {
      notify() {},
      setStatus: (key: string, value: string | undefined) => { statuses[key] = value },
      setWidget: (key: string, value: string[] | undefined) => { widgets[key] = value },
      theme: {
        fg: (_style: string, value: string) => value,
        strikethrough: (value: string) => value,
      },
    },
  }

  registerWorkflowClaimApi(pi, {
    async claimWorkflowBead(beadId: string) {
      if (options.activeStatus === 'in_progress' || options.activeStatus === 'inreview') {
        return { ok: false, state: { activeBead: 'bead-current', bdStatus: options.activeStatus } }
      }
      const show = await pi.exec('bd', ['show', beadId, '--json'])
      if (show.code !== 0) return { ok: false }
      const claim = await pi.exec('bd', ['update', beadId, '--claim', '--json'])
      if (claim.code === 0) workflowUpdates.push({ activeBead: beadId, sessionMode: 'claimed' })
      return { ok: claim.code === 0 }
    },
  })

  loadPlanModeExtension()(pi)
  return { commandHandlers, toolHandlers, workflowUpdates, statuses, widgets, activeTools, inputHandlers, toolCallHandlers, execCalls, delayedClaimEvents, ctx }
}

describe('Pi plan-mode workflow synchronization', () => {
  it('plan-cancel publishes plan=off and clears visible plan status', async () => {
    const { commandHandlers, workflowUpdates, statuses, widgets, activeTools, ctx } = makeHarness()

    await commandHandlers.get('plan')?.handler('', ctx)
    await commandHandlers.get('plan-cancel')?.handler('', ctx)

    expect(workflowUpdates.at(-2)).toMatchObject({ planMode: 'strict', sessionMode: 'planning' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'idle' })
    expect(statuses['plan-mode']).toBeUndefined()
    expect(widgets['plan-todos']).toBeUndefined()
    expect(activeTools.at(-1)).toEqual(['read', 'bash', 'edit', 'write'])
  })

  it('parses varied explicit claim+plan workflow intents without matching full phrases', () => {
    for (const text of [
      'beads-task-issue-tracker-zzkb возьми эту задачу в работу, выполняй в режиме планирования',
      'заклейми beads-task-issue-tracker-zzkb, делай в режиме планирования',
      'claim beads-task-issue-tracker-zzkb and plan first',
    ]) {
      const intent = parseWorkflowIntent(text)
      expect(shouldAutoClaimAndPlan(intent)).toBe(true)
      expect(intent.beadId).toBe('beads-task-issue-tracker-zzkb')
    }
  })

  it('does not auto-claim questions, negations, multiple bead ids, or examples in fenced code', () => {
    for (const text of [
      'можно ли взять beads-task-issue-tracker-zzkb в режим планирования?',
      'не бери beads-task-issue-tracker-zzkb в режим планирования',
      'возьми beads-task-issue-tracker-zzkb и beads-task-issue-tracker-qf7m в режим планирования',
      '```\nclaim beads-task-issue-tracker-zzkb and plan first\n```',
    ]) {
      expect(shouldAutoClaimAndPlan(parseWorkflowIntent(text))).toBe(false)
    }
  })

  it('handles explicit claim+plan input through awaitable workflow claim API with Pi-like void events.emit semantics', async () => {
    const { inputHandlers, workflowUpdates, activeTools, execCalls, delayedClaimEvents, ctx } = makeHarness()

    const result = await inputHandlers[0]?.({ source: 'user', text: 'beads-task-issue-tracker-zzkb возьми эту задачу в работу, выполняй в режиме планирования' }, ctx)
    await Promise.resolve()

    expect(result).toEqual({ action: 'handled' })
    expect(execCalls).toEqual(expect.arrayContaining([
      { command: 'bd', args: ['show', 'beads-task-issue-tracker-zzkb', '--json'] },
      { command: 'bd', args: ['update', 'beads-task-issue-tracker-zzkb', '--claim', '--json'] },
    ]))
    expect(delayedClaimEvents).toEqual([])
    expect(workflowUpdates.at(-2)).toMatchObject({ activeBead: 'beads-task-issue-tracker-zzkb', sessionMode: 'claimed' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'strict', sessionMode: 'planning' })
    expect(activeTools.at(-1)).toEqual(['read', 'bash', 'grep', 'find', 'ls', 'questionnaire'])
  })

  it('does not run an unrelated bd update --claim for claim+plan when current-session bead is in_progress', async () => {
    const { inputHandlers, workflowUpdates, activeTools, execCalls, ctx } = makeHarness({ activeStatus: 'in_progress' })

    const result = await inputHandlers[0]?.({ source: 'user', text: 'claim beads-task-issue-tracker-zzkb and plan first' }, ctx)

    expect(result).toEqual({ action: 'handled' })
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args[1] === 'beads-task-issue-tracker-zzkb' && call.args.includes('--claim'))).toBe(false)
    expect(workflowUpdates.some((update: any) => update.planMode === 'strict')).toBe(false)
    expect(activeTools.at(-1)).not.toEqual(['read', 'bash', 'grep', 'find', 'ls', 'questionnaire'])
  })

  it('does not run an unrelated bd update --claim for claim+plan when current-session bead is inreview', async () => {
    const { inputHandlers, workflowUpdates, activeTools, execCalls, ctx } = makeHarness({ activeStatus: 'inreview' })

    const result = await inputHandlers[0]?.({ source: 'user', text: 'claim beads-task-issue-tracker-zzkb and plan first' }, ctx)

    expect(result).toEqual({ action: 'handled' })
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args[1] === 'beads-task-issue-tracker-zzkb' && call.args.includes('--claim'))).toBe(false)
    expect(workflowUpdates.some((update: any) => update.planMode === 'strict')).toBe(false)
    expect(activeTools.at(-1)).not.toEqual(['read', 'bash', 'grep', 'find', 'ls', 'questionnaire'])
  })
})


describe('Pi plan-mode typed workflow tools', () => {
  it('workflow_plan_mode strict and off change active tools and workflow state', async () => {
    const { toolHandlers, workflowUpdates, activeTools, ctx } = makeHarness()

    await toolHandlers.get('workflow_plan_mode')?.execute('call-1', { mode: 'strict', reason: 'plan first' }, undefined, undefined, ctx)
    await toolHandlers.get('workflow_plan_mode')?.execute('call-2', { mode: 'off', reason: 'cancel' }, undefined, undefined, ctx)

    expect(workflowUpdates.at(-2)).toMatchObject({ planMode: 'strict', sessionMode: 'planning' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'idle' })
    expect(activeTools.at(-2)).toEqual(['read', 'bash', 'grep', 'find', 'ls', 'questionnaire'])
    expect(activeTools.at(-1)).toEqual(['read', 'bash', 'edit', 'write'])
  })

  it('plan-mode bash block message points agents to workflow_plan_mode, not slash-only recovery', async () => {
    const { commandHandlers, toolCallHandlers, ctx } = makeHarness()

    await commandHandlers.get('plan')?.handler('', ctx)
    const decision = await toolCallHandlers[0]?.({ toolName: 'bash', input: { command: 'rm -rf tmp' } }, ctx) as { block: boolean, reason: string }

    expect(decision).toMatchObject({ block: true })
    expect(decision.reason).toContain('workflow_plan_mode')
    expect(decision.reason).toContain('optional human UI shortcut')
    expect(decision.reason).not.toContain('Use /plan')
  })

  it('workflow_plan_approved requires evidence and only updates state after bd comment succeeds', async () => {
    const { toolHandlers, workflowUpdates, activeTools, execCalls, ctx } = makeHarness()

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-1', { beadId: 'bead-plan', planEvidence: 'too short' }, undefined, undefined, ctx)
    const approved = await toolHandlers.get('workflow_plan_approved')?.execute('call-2', { beadId: 'bead-plan', planEvidence: 'Plan: update typed tools. Files: .pi/extensions/plan-mode/index.ts. Acceptance: tests verify approval.' }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('blocked')
    expect(approved.content[0].text).toContain('workflow_plan_approved recorded')
    expect(execCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates.at(-1)).toMatchObject({ activeBead: 'bead-plan', planMode: 'off', sessionMode: 'implementing', planApproved: true })
    expect(activeTools.at(-1)).toEqual(['read', 'bash', 'edit', 'write'])
  })
})
