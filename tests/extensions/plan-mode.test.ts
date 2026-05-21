import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

import { registerWorkflowClaimApi, requestWorkflowClaim } from '../../.pi/extensions/workflow-state/index'
import { parseWorkflowIntent, shouldAutoClaimAndPlan } from '../../.pi/extensions/workflow-intent/index'
import { isSafeCommand } from '../../.pi/extensions/plan-mode/utils'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions/plan-mode/index.ts'), 'utf8')
const expectedPlanTools = ['read', 'bash', 'grep', 'find', 'ls', 'questionnaire', 'workflow_status', 'workflow_plan_mode', 'workflow_plan_approved', 'workflow_plan_review']
const mandatoryWorkflowTools = [
  'workflow_status',
  'workflow_claim',
  'workflow_reset',
  'workflow_update',
  'workflow_submit_for_review',
  'workflow_complete',
  'dispatch_supervisor',
  'dispatch_reviewer',
  'dispatch_docs_agent',
  'review_bead',
]
const expectedNormalTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'subagent', ...mandatoryWorkflowTools]
let mockPlanReviewGateOk = true
let mockPlanReviewReasons: string[] = []
let mockMissingRevisedPlanSections: string[] = []
let mockRenderedPlanReviewResults = 'PLAN REVIEW: APPROVED'

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
    if (id === '../plan-review/index') {
      return {
        evaluatePlanReviewGate: (results: unknown[]) => ({ ok: mockPlanReviewGateOk, reasons: mockPlanReviewReasons, results, missingReviewers: mockPlanReviewReasons.filter((reason) => reason.startsWith('missing reviewer:')), blockedReviewers: [] }),
        missingRevisedPlanSections: () => mockMissingRevisedPlanSections,
        renderPlanReviewResults: () => mockRenderedPlanReviewResults,
        runPlanReviewers: async () => ['plan-edge-reviewer', 'plan-consistency-reviewer', 'plan-dead-zone-reviewer'].map((reviewer) => ({ reviewer, verdict: 'APPROVED', findings: [], unresolvedBlockers: [], raw: 'PLAN REVIEW: APPROVED' })),
      }
    }
    if (id === '@earendil-works/pi-agent-core' || id === '@earendil-works/pi-ai' || id === '@earendil-works/pi-coding-agent') return {}
    throw new Error(`Unexpected require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(mockRequire, module, module.exports)
  if (!module.exports.default) throw new Error('plan-mode default export not loaded')
  return module.exports.default
}

function makeHarness(options: { activeStatus?: 'in_progress' | 'inreview', registerClaimApiOnDifferentPi?: boolean, taskScopeGit?: boolean } = {}) {
  mockPlanReviewGateOk = true
  mockPlanReviewReasons = []
  mockMissingRevisedPlanSections = []
  mockRenderedPlanReviewResults = 'PLAN REVIEW: APPROVED'
  const commandHandlers = new Map<string, { handler: (args: string, ctx: any) => unknown }>()
  const toolHandlers = new Map<string, any>()
  const workflowUpdates: unknown[] = []
  const statuses: Record<string, string | undefined> = {}
  const widgets: Record<string, string[] | undefined> = {}
  const activeTools: string[][] = []
  let currentActiveTools = [...expectedNormalTools]
  const allTools = [...new Set([...expectedNormalTools, ...expectedPlanTools])].map((name) => ({ name }))
  const inputHandlers: Array<(event: any, ctx: any) => unknown> = []
  const toolCallHandlers: Array<(event: any, ctx: any) => unknown> = []
  const agentEndHandlers: Array<(event: any, ctx: any) => unknown> = []
  const sendMessages: Array<{ message: any, options?: any }> = []
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
      if (event === 'agent_end') agentEndHandlers.push(handler)
    },
    appendEntry() {},
    sendMessage: (message: any, options?: any) => sendMessages.push({ message, options }),
    getActiveTools: () => currentActiveTools.map((name) => ({ name })),
    getAllTools: () => allTools,
    setActiveTools: (tools: string[]) => {
      currentActiveTools = [...tools]
      activeTools.push(tools)
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'bd' && args[0] === 'show') return { stdout: '[{"id":"beads-task-issue-tracker-zzkb","status":"open"}]', stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'update') return { stdout: '[{"id":"beads-task-issue-tracker-zzkb","status":"in_progress"}]', stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '{"ok":true}', stderr: '', code: 0 }
      if (command === 'git' && options.taskScopeGit && args[0] === '-C') {
        if (args[1] !== '/tmp/task') return { stdout: '', stderr: 'not a git repository', code: 128 }
        if (args.includes('branch')) return { stdout: 'task/plan-approved\n', stderr: '', code: 0 }
        if (args.includes('--show-toplevel')) return { stdout: '/tmp/task\n', stderr: '', code: 0 }
        if (args.includes('HEAD')) return { stdout: 'task123\n', stderr: '', code: 0 }
      }
      if (command === 'git' && args.includes('branch')) return { stdout: 'main\n', stderr: '', code: 0 }
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

  const claimApiPi = options.registerClaimApiOnDifferentPi ? { lifecycle: 'workflow-state-proxy' } : pi
  registerWorkflowClaimApi(claimApiPi, {
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
  return { commandHandlers, toolHandlers, workflowUpdates, statuses, widgets, activeTools, inputHandlers, toolCallHandlers, agentEndHandlers, sendMessages, execCalls, delayedClaimEvents, ctx }
}

describe('Pi plan-mode bash allowlist', () => {
  it('allows read-only bd comments inspection commands', () => {
    expect(isSafeCommand('bd comments beads-task-issue-tracker-z3i4')).toBe(true)
    expect(isSafeCommand('bd comments beads-task-issue-tracker-z3i4 --json')).toBe(true)
  })

  it('blocks mutating bd comments commands', () => {
    for (const command of [
      'bd comments add beads-task-issue-tracker-z3i4 test',
      'bd comments delete beads-task-issue-tracker-z3i4 comment-1',
      'bd comments rm beads-task-issue-tracker-z3i4 comment-1',
    ]) {
      expect(isSafeCommand(command)).toBe(false)
    }
  })

  it('allows git log history inspection with pathspec and read-only head pipe', () => {
    expect(isSafeCommand("git log --oneline --since='2026-05-15 03:06:06 +0000' -- .pi AGENTS.md tests/extensions | head -80")).toBe(true)
  })

  it('blocks unsafe shell composition after an allowlisted read-only command', () => {
    for (const command of [
      'git log --oneline | sh',
      'bd comments beads-task-issue-tracker-z3i4 && sh',
      'git log --oneline; sh',
    ]) {
      expect(isSafeCommand(command)).toBe(false)
    }
  })

  it('blocks mutating git and bd commands even when they include safe-looking arguments', () => {
    for (const command of [
      'git commit --dry-run -- .pi/extensions/plan-mode/utils.ts',
      'git push --dry-run origin task/z3i4-plan-mode-allowlist',
      'bd update beads-task-issue-tracker-z3i4 --priority 1 --json',
      'bd dolt pull',
    ]) {
      expect(isSafeCommand(command)).toBe(false)
    }
  })
})

describe('Pi plan-mode workflow synchronization', () => {
  it('plan-cancel publishes plan=off and clears visible plan status', async () => {
    const { commandHandlers, workflowUpdates, statuses, widgets, activeTools, ctx } = makeHarness()

    await commandHandlers.get('plan')?.handler('', ctx)
    await commandHandlers.get('plan-cancel')?.handler('', ctx)

    expect(workflowUpdates.at(-2)).toMatchObject({ planMode: 'strict', sessionMode: 'planning' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'idle' })
    expect(statuses['plan-mode']).toBeUndefined()
    expect(widgets['plan-todos']).toBeUndefined()
    expect(activeTools.at(-1)).toEqual(expectedNormalTools)
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
    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
  })

  it('handles claim+plan when workflow-state registered the guarded claim API on a different Pi proxy object', async () => {
    const { inputHandlers, workflowUpdates, activeTools, execCalls, ctx } = makeHarness({ registerClaimApiOnDifferentPi: true })

    const result = await inputHandlers[0]?.({ source: 'user', text: 'claim beads-task-issue-tracker-zzkb and plan first' }, ctx)

    expect(result).toEqual({ action: 'handled' })
    expect(execCalls).toEqual(expect.arrayContaining([
      { command: 'bd', args: ['show', 'beads-task-issue-tracker-zzkb', '--json'] },
      { command: 'bd', args: ['update', 'beads-task-issue-tracker-zzkb', '--claim', '--json'] },
    ]))
    expect(workflowUpdates.at(-2)).toMatchObject({ activeBead: 'beads-task-issue-tracker-zzkb', sessionMode: 'claimed' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'strict', sessionMode: 'planning' })
    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
  })

  it('does not run an unrelated bd update --claim for claim+plan when current-session bead is in_progress', async () => {
    const { inputHandlers, workflowUpdates, activeTools, execCalls, ctx } = makeHarness({ activeStatus: 'in_progress' })

    const result = await inputHandlers[0]?.({ source: 'user', text: 'claim beads-task-issue-tracker-zzkb and plan first' }, ctx)

    expect(result).toEqual({ action: 'handled' })
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args[1] === 'beads-task-issue-tracker-zzkb' && call.args.includes('--claim'))).toBe(false)
    expect(workflowUpdates.some((update: any) => update.planMode === 'strict')).toBe(false)
    expect(activeTools.at(-1)).not.toEqual(expectedPlanTools)
  })

  it('does not run an unrelated bd update --claim for claim+plan when current-session bead is inreview', async () => {
    const { inputHandlers, workflowUpdates, activeTools, execCalls, ctx } = makeHarness({ activeStatus: 'inreview' })

    const result = await inputHandlers[0]?.({ source: 'user', text: 'claim beads-task-issue-tracker-zzkb and plan first' }, ctx)

    expect(result).toEqual({ action: 'handled' })
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args[1] === 'beads-task-issue-tracker-zzkb' && call.args.includes('--claim'))).toBe(false)
    expect(workflowUpdates.some((update: any) => update.planMode === 'strict')).toBe(false)
    expect(activeTools.at(-1)).not.toEqual(expectedPlanTools)
  })
})

describe('Pi plan-mode typed workflow tools', () => {
  it('workflow_plan_mode strict and off change active tools and workflow state', async () => {
    const { toolHandlers, workflowUpdates, activeTools, ctx } = makeHarness()

    await toolHandlers.get('workflow_plan_mode')?.execute('call-1', { mode: 'strict', reason: 'plan first' }, undefined, undefined, ctx)

    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
    for (const mutatingWorkflowTool of ['dispatch_supervisor', 'dispatch_reviewer', 'dispatch_docs_agent', 'review_bead', 'workflow_submit_for_review', 'workflow_complete']) {
      expect(activeTools.at(-1)).not.toContain(mutatingWorkflowTool)
    }

    await toolHandlers.get('workflow_plan_mode')?.execute('call-2', { mode: 'off', reason: 'cancel' }, undefined, undefined, ctx)

    expect(workflowUpdates.at(-2)).toMatchObject({ planMode: 'strict', sessionMode: 'planning' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'idle' })
    expect(activeTools.at(-2)).toEqual(expectedPlanTools)
    expect(activeTools.at(-1)).toEqual(expectedNormalTools)
    expect(activeTools.at(-1)).toEqual(expect.arrayContaining(mandatoryWorkflowTools))
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

  it('workflow_plan_review is available in plan mode, returns findings, blocks failures, and avoids workflow/bd/git mutations', async () => {
    const { toolHandlers, workflowUpdates, activeTools, execCalls, ctx } = makeHarness()

    await toolHandlers.get('workflow_plan_mode')?.execute('call-setup', { mode: 'strict' }, undefined, undefined, ctx)
    const beforeWorkflowUpdates = workflowUpdates.length
    const beforeExecCalls = execCalls.length
    const ok = await toolHandlers.get('workflow_plan_review')?.execute('call-review-ok', { draftPlan: `Plan:\n1. Implement typed plan review tool.` }, undefined, undefined, ctx)
    mockPlanReviewGateOk = false
    mockPlanReviewReasons = ['missing reviewer: plan-dead-zone-reviewer', 'blocked reviewer: plan-consistency-reviewer']
    mockRenderedPlanReviewResults = 'PLAN REVIEW: BLOCKED'
    const blocked = await toolHandlers.get('workflow_plan_review')?.execute('call-review-blocked', { draftPlan: `Plan:\n1. Implement typed plan review tool.` }, undefined, undefined, ctx)

    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
    expect(ok.content[0].text).toContain('workflow_plan_review complete')
    expect(ok.content[0].text).toContain('PLAN REVIEW: APPROVED')
    expect(ok.details).toMatchObject({ ok: true })
    expect(blocked.content[0].text).toContain('missing reviewer: plan-dead-zone-reviewer')
    expect(blocked.content[0].text).toContain('blocked reviewer: plan-consistency-reviewer')
    expect(blocked.details).toMatchObject({ ok: false })
    expect(workflowUpdates).toHaveLength(beforeWorkflowUpdates)
    expect(execCalls).toHaveLength(beforeExecCalls)
    expect(source).toEqual(expect.stringContaining('MUST call workflow_plan_review'))
    expect(source).toEqual(expect.stringContaining('Accepted findings'))
    expect(source).toEqual(expect.stringContaining('Rejected findings'))
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
    expect(workflowUpdates.at(-1)).toMatchObject({ state: 'implementing', activeBead: 'bead-plan', planMode: 'off', sessionMode: 'implementing', planApproved: true })
    expect(activeTools.at(-1)).toEqual(expectedNormalTools)
    expect(activeTools.at(-1)).toEqual(expect.arrayContaining(mandatoryWorkflowTools))
  })

  it('workflow_plan_approved prefers explicit approved task worktree scope over main ctx cwd', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({ taskScopeGit: true })

    const approved = await toolHandlers.get('workflow_plan_approved')?.execute('call-task-scope', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: continue in the approved task worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow state keeps task scope.',
        'Branch: task/plan-approved',
        'Worktree: /tmp/task',
        'START_COMMIT: task123',
      ].join('\n'),
    }, undefined, undefined, ctx)

    const commentCall = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(approved.content[0].text).toContain('workflow_plan_approved recorded')
    expect(commentCall?.args[3]).toContain('BRANCH: task/plan-approved')
    expect(commentCall?.args[3]).toContain('WORKTREE: /tmp/task')
    expect(commentCall?.args[3]).toContain('START_COMMIT: task123')
    expect(workflowUpdates.at(-1)).toMatchObject({
      state: 'implementing',
      activeBead: 'bead-plan',
      branch: 'task/plan-approved',
      worktreePath: '/tmp/task',
      startCommit: 'task123',
      planMode: 'off',
      sessionMode: 'implementing',
      planApproved: true,
    })
  })

  it('workflow_plan_approved blocks explicit invalid evidence worktree without bd comment or state update', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({ taskScopeGit: true })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-invalid-worktree', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: continue in the approved task worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow state keeps task scope.',
        'Branch: task/plan-approved',
        'Worktree: /tmp/missing',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('not a readable git worktree')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
  })

  it('workflow_plan_approved blocks explicit evidence branch mismatch without bd comment or state update', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({ taskScopeGit: true })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-branch-mismatch', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: continue in the approved task worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow state keeps task scope.',
        'Branch: task/wrong',
        'Worktree: /tmp/task',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('does not match worktree branch task/plan-approved')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
  })

  it('/plan-auto runs plan-review gate before execution and asks for a revised plan', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, activeTools, ctx } = makeHarness()

    await commandHandlers.get('plan-auto')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement gate' }] }] }, ctx)

    expect(sendMessages.at(-1)?.message.customType).toBe('plan-review-findings')
    expect(sendMessages.at(-1)?.message.content).toContain('Reviewer findings')
    expect(sendMessages.at(-1)?.options).toMatchObject({ triggerTurn: true })
    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
  })

  it('/plan-auto blocks execution when a required reviewer blocks the gate', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, activeTools, ctx } = makeHarness()
    mockPlanReviewGateOk = false
    mockPlanReviewReasons = ['blocked reviewer: plan-dead-zone-reviewer']

    await commandHandlers.get('plan-auto')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement gate' }] }] }, ctx)

    expect(sendMessages.at(-1)?.message.customType).toBe('plan-review-gate-blocked')
    expect(sendMessages.at(-1)?.message.content).toContain('blocked reviewer: plan-dead-zone-reviewer')
    expect(sendMessages.at(-1)?.options).toMatchObject({ triggerTurn: false })
    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
  })

  it('/plan-auto executes a revised plan with review adjudication sections', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, activeTools, workflowUpdates, ctx } = makeHarness()

    await commandHandlers.get('plan-auto')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft gate' }] }] }, ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: `Reviewer findings summary:\n- reviewers approved\nAccepted findings:\n- none\nRejected findings:\n- none\nUnresolved blockers: none\nRevised plan:\n1. Implement gate\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- tests pass\nRisks / rollback:\n- revert\nAUTO_EXECUTE_ALLOWED: true` }] }] }, ctx)

    expect(sendMessages.at(-1)?.message.customType).toBe('plan-mode-execute')
    expect(sendMessages.at(-1)?.message.content).toContain('Execute the revised plan')
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'implementing', planApproved: true })
    expect(activeTools.at(-1)).toEqual(expectedNormalTools)
    expect(activeTools.at(-1)).toEqual(expect.arrayContaining(mandatoryWorkflowTools))
  })
})
