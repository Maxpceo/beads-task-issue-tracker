import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

import { currentRuntimeOwnerKey, registerWorkflowClaimApi, requestWorkflowClaim } from '../../.pi/extensions/workflow-state/index'
import { parseWorkflowIntent, shouldAutoClaimAndPlan } from '../../.pi/extensions/workflow-intent/index'
import { isSafeCommand } from '../../.pi/extensions/plan-mode/utils'
import * as worktreeScope from '../../.pi/extensions/worktree-scope/index'
import {
  classifyPlanReviewRisk,
  evaluatePlanReviewGate as realEvaluatePlanReviewGate,
  hasImportantOrCriticalFindings,
  planReviewStopAdvice,
  type PlanReviewFinding,
  type PlanReviewResult,
} from '../../.pi/extensions/plan-review/index'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions/plan-mode/index.ts'), 'utf8')
const expectedPlanTools = ['read', 'bash', 'grep', 'find', 'ls', 'questionnaire', 'workflow_status', 'workflow_plan_mode', 'workflow_plan_approved', 'workflow_plan_review', 'plan_subagent']
const hopWorkflowTools = [
  'complete_visible_dispatch',
  'followup_visible_dispatch',
  'close_visible_dispatch',
]
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
  ...hopWorkflowTools,
]
const expectedNormalTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'subagent', 'plan_subagent', ...mandatoryWorkflowTools]
let mockPlanReviewGateOk = true
let mockPlanReviewReasons: string[] = []
let mockPlanReviewImportantFindings: PlanReviewFinding[] = []
let mockPlanReviewResults: PlanReviewResult[] | undefined
let mockPlanReviewSpawnCount = 0
let mockPlanReviewSpawnError: Error | undefined
let mockPlanReviewSpawnGate: Promise<void> | undefined
let mockMissingRevisedPlanSections: string[] = []
let mockRenderedPlanReviewResults = 'PLAN REVIEW: APPROVED'
let mockSupervisorDispatchAvailable = true
let mockSupervisorDispatchCalls: Array<{ beadId: string; cwd?: string; transport?: string }> = []
let mockSupervisorDispatchGate: Promise<void> | undefined
let mockSupervisorDispatchSpawned = false
let mockCompleteVisibleCalls: Array<{ taskId: string }> = []
let mockCompleteVisibleResult: { status: string; text: string } = { status: 'submitted', text: 'ok' }
let mockCompleteVisibleImpl: ((taskId: string) => Promise<{ status: string; text: string }>) | undefined
let mockReviewerDispatchCalls: Array<{ beadId: string; cwd?: string; transport?: string }> = []
let mockReviewerDispatchResult: { ok: boolean; text: string; error?: string } = { ok: true, text: 'status=spawned' }
let mockCloseVisibleCalls: Array<{ beadId: string; stopClose?: boolean; pendingFix?: boolean }> = []
let mockCloseVisibleResult: { status: string; text: string; closed?: string[]; tombstoned?: string[] } = {
  status: 'closed',
  text: 'closed panes',
  closed: ['surface:1'],
  tombstoned: ['task-1'],
}
let mockCloseVisibleImpl: ((beadId: string, params?: { stopClose?: boolean; pendingFix?: boolean }) => Promise<{ status: string; text: string }>) | undefined
let mockCloseVisibleThrow: Error | undefined
let mockReviewerDispatchThrow: Error | undefined
let mockFinalizeCloseResult: { ok: boolean; status: string; text: string; blockingRows?: Array<{ item: string; result: string; evidence?: string }> } = { ok: true, status: 'closed', text: 'closed' }
let mockFinalizeCloseCalls: Array<{ beadId: string; worktreePath: string }> = []
let mockRegistryByTaskId: Record<string, { entry: { beadId: string; worktree: string; role: string; startCommit?: string; status?: string } }> = {}
let mockLiveRegistryByBead: Record<string, Array<{ entry: { role: string; status?: string } }>> = {}

function defaultMockPlanReviewResults(): PlanReviewResult[] {
  return ['plan-edge-reviewer', 'plan-consistency-reviewer', 'plan-dead-zone-reviewer'].map((reviewer) => ({
    reviewer,
    verdict: 'APPROVED' as const,
    findings: [] as PlanReviewFinding[],
    unresolvedBlockers: [] as string[],
    raw: 'PLAN REVIEW: APPROVED',
  }))
}

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
    if (id === '../workflow-state/index') return { currentRuntimeOwnerKey, requestWorkflowClaim }
    if (id === '../workflow-intent/index') return { parseWorkflowIntent, shouldAutoClaimAndPlan }
    if (id === '../plan-review/index') {
      return {
        MAX_PLAN_REVIEW_CYCLES: 2,
        classifyPlanReviewRisk,
        planReviewStopAdvice,
        hasImportantOrCriticalFindings,
        evaluatePlanReviewGate: (results: PlanReviewResult[]) => {
          if (!mockPlanReviewGateOk || mockPlanReviewReasons.length > 0) {
            const importantFindings = mockPlanReviewImportantFindings.length > 0
              ? mockPlanReviewImportantFindings
              : results.flatMap((result) => result.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'important'))
            return {
              ok: false,
              reasons: mockPlanReviewReasons.length > 0 ? mockPlanReviewReasons : ['blocked reviewer: mock'],
              results,
              missingReviewers: mockPlanReviewReasons.filter((reason) => reason.startsWith('missing reviewer:')).map((reason) => reason.replace('missing reviewer: ', '')),
              blockedReviewers: results.filter((result) => result.verdict === 'BLOCKED' || Boolean(result.error)),
              unresolvedBlockers: [],
              importantFindings,
            }
          }
          if (mockPlanReviewImportantFindings.length > 0) {
            return {
              ok: true,
              reasons: [],
              results,
              missingReviewers: [],
              blockedReviewers: [],
              unresolvedBlockers: [],
              importantFindings: mockPlanReviewImportantFindings,
            }
          }
          return realEvaluatePlanReviewGate(results)
        },
        missingRevisedPlanSections: () => mockMissingRevisedPlanSections,
        renderPlanReviewResults: (results?: PlanReviewResult[]) => {
          if (results && results.length > 0 && mockRenderedPlanReviewResults === 'PLAN REVIEW: APPROVED') {
            return results.map((result) => `## ${result.reviewer}\nPLAN REVIEW: ${result.verdict}`).join('\n\n')
          }
          return mockRenderedPlanReviewResults
        },
        runPlanReviewers: async () => {
          mockPlanReviewSpawnCount += 1
          if (mockPlanReviewSpawnGate) await mockPlanReviewSpawnGate
          if (mockPlanReviewSpawnError) throw mockPlanReviewSpawnError
          return mockPlanReviewResults ?? defaultMockPlanReviewResults()
        },
      }
    }
    if (id === '../worktree-scope/index') return worktreeScope
    if (id === '../beads-dispatch/index') {
      return {
        requestSupervisorDispatch: async (_pi: unknown, params: { beadId: string; cwd?: string; transport?: string }) => {
          mockSupervisorDispatchCalls.push(params)
          await mockSupervisorDispatchGate
          if (!mockSupervisorDispatchAvailable) return { ok: false, text: '', error: 'runtime hook missing: test API unavailable' }
          if (mockSupervisorDispatchSpawned) {
            return { ok: true, text: 'status=spawned', details: { status: 'spawned', transport: 'cmux', beadId: params.beadId } }
          }
          return { ok: true, text: `agent=test-supervisor\nbead=${params.beadId}\nworktree=${params.cwd ?? '/tmp/project'}\nexit=0`, details: { beadId: params.beadId, worktreePath: params.cwd } }
        },
        requestReviewerDispatch: async (_pi: unknown, params: { beadId: string; cwd?: string; transport?: string }) => {
          mockReviewerDispatchCalls.push(params)
          if (mockReviewerDispatchThrow) throw mockReviewerDispatchThrow
          return mockReviewerDispatchResult
        },
        parseVisiblePing: (text: string) => {
          const errorMatch = /\[PING-ERROR\]/i.test(text)
          const okMatch = !errorMatch && /\[PING\]/i.test(text)
          if (!errorMatch && !okMatch) return undefined
          const taskId = text.match(/\btaskId\s*=\s*([^\s,;]+)/i)?.[1] ?? text.match(/задача\s+([^\s:.,;]+)/iu)?.[1]
          return { kind: errorMatch ? 'error' : 'ok', taskId, missingId: !taskId, text }
        },
        completeVisibleDispatch: async (_pi: unknown, params: { taskId: string }) => {
          mockCompleteVisibleCalls.push(params)
          if (mockCompleteVisibleImpl) return mockCompleteVisibleImpl(params.taskId)
          return mockCompleteVisibleResult
        },
        closeVisibleDispatch: async (_pi: unknown, params: { beadId: string; stopClose?: boolean; pendingFix?: boolean }) => {
          mockCloseVisibleCalls.push(params)
          if (mockCloseVisibleThrow) throw mockCloseVisibleThrow
          if (mockCloseVisibleImpl) return mockCloseVisibleImpl(params.beadId, params)
          return { ...mockCloseVisibleResult, text: mockCloseVisibleResult.text || `closed panes for ${params.beadId}` }
        },
        findRegistryByTaskId: (taskId: string) => mockRegistryByTaskId[taskId],
        findLiveRegistryEntriesForBead: (beadId: string) => mockLiveRegistryByBead[beadId] ?? [],
      }
    }
    if (id === '../review-workflow/index') {
      return {
        finalizeVisibleReviewClose: async (_pi: unknown, params: { beadId: string; worktreePath: string }) => {
          mockFinalizeCloseCalls.push(params)
          return mockFinalizeCloseResult
        },
      }
    }
    if (id === '@earendil-works/pi-agent-core' || id === '@earendil-works/pi-ai' || id === '@earendil-works/pi-coding-agent') return {}
    throw new Error(`Unexpected require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(mockRequire, module, module.exports)
  if (!module.exports.default) throw new Error('plan-mode default export not loaded')
  return module.exports.default
}

function makeHarness(options: { activeStatus?: 'in_progress' | 'inreview', registerClaimApiOnDifferentPi?: boolean, taskScopeGit?: boolean, commentAddFails?: boolean, activeBead?: string, entries?: Array<{ type?: string; customType?: string; data?: unknown }>, failPreDispatchProgressMessage?: boolean, initialActiveTools?: string[], registeredTools?: string[] } = {}) {
  const taskScopeGit = options.taskScopeGit ?? true
  mockPlanReviewGateOk = true
  mockPlanReviewReasons = []
  mockPlanReviewImportantFindings = []
  mockPlanReviewResults = undefined
  mockPlanReviewSpawnCount = 0
  mockPlanReviewSpawnError = undefined
  mockPlanReviewSpawnGate = undefined
  mockMissingRevisedPlanSections = []
  mockRenderedPlanReviewResults = 'PLAN REVIEW: APPROVED'
  mockSupervisorDispatchAvailable = true
  mockSupervisorDispatchCalls = []
  mockSupervisorDispatchGate = undefined
  mockSupervisorDispatchSpawned = false
  mockCompleteVisibleCalls = []
  mockCompleteVisibleResult = { status: 'submitted', text: 'ok' }
  mockCompleteVisibleImpl = undefined
  mockReviewerDispatchCalls = []
  mockReviewerDispatchResult = { ok: true, text: 'status=spawned' }
  mockReviewerDispatchThrow = undefined
  mockCloseVisibleCalls = []
  mockCloseVisibleResult = { status: 'closed', text: 'closed panes', closed: ['surface:1'], tombstoned: ['task-1'] }
  mockCloseVisibleImpl = undefined
  mockCloseVisibleThrow = undefined
  mockFinalizeCloseResult = { ok: true, status: 'closed', text: 'closed' }
  mockFinalizeCloseCalls = []
  mockRegistryByTaskId = {
    'task-sup': { entry: { beadId: 'bead-plan', worktree: '/tmp/task', role: 'test-supervisor', startCommit: 'task123', status: 'spawned' } },
    'task-rev': { entry: { beadId: 'bead-plan', worktree: '/tmp/task', role: 'code-reviewer', startCommit: 'task123', status: 'spawned' } },
  }
  mockLiveRegistryByBead = {}
  const commandHandlers = new Map<string, { handler: (args: string, ctx: any) => unknown }>()
  const toolHandlers = new Map<string, any>()
  const workflowUpdates: unknown[] = []
  const statuses: Record<string, string | undefined> = {}
  const widgets: Record<string, string[] | undefined> = {}
  const activeTools: string[][] = []
  let currentActiveTools = [...(options.initialActiveTools ?? expectedNormalTools)]
  // getAllTools always registers hop tools when present in expectedNormalTools, even if pre-plan active surface omitted them.
  const allTools = [...new Set([...(options.registeredTools ?? expectedNormalTools), ...expectedPlanTools, ...hopWorkflowTools])].map((name) => ({ name }))
  const inputHandlers: Array<(event: any, ctx: any) => unknown> = []
  const toolCallHandlers: Array<(event: any, ctx: any) => unknown> = []
  const agentEndHandlers: Array<(event: any, ctx: any) => unknown> = []
  const sessionStartHandlers: Array<(event: any, ctx: any) => unknown> = []
  const beforeAgentStartHandlers: Array<(event?: any, ctx?: any) => unknown> = []
  const sendMessages: Array<{ message: any, options?: any }> = []
  const sendUserMessages: string[] = []
  const execCalls: Array<{ command: string, args: string[] }> = []
  const delayedClaimEvents: unknown[] = []
  const trace: string[] = []
  const sessionEntries: Array<{ type?: string, customType?: string, data?: unknown }> = options.entries ?? [
    { type: 'custom', customType: 'workflow-state', data: { activeBead: options.activeBead ?? 'bead-plan', branch: 'task/plan-approved', worktreePath: '/tmp/task', startCommit: 'task123' } },
  ]

  const pi: any = {
    registerFlag() {},
    getFlag() { return false },
    registerCommand: (name: string, config: { handler: (args: string, ctx: any) => unknown }) => commandHandlers.set(name, config),
    registerTool: (tool: any) => toolHandlers.set(tool.name, tool),
    registerShortcut() {},
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      if (event === 'input') inputHandlers.push(handler)
      if (event === 'tool_call') toolCallHandlers.push(handler)
      if (event === 'agent_end') agentEndHandlers.push(handler)
      if (event === 'session_start') sessionStartHandlers.push(handler)
      if (event === 'before_agent_start') beforeAgentStartHandlers.push(handler)
    },
    appendEntry: (customType: string, data: unknown) => { sessionEntries.push({ type: 'custom', customType, data }) },
    sendMessage: (message: any, sendOptions?: any) => {
      if (options.failPreDispatchProgressMessage && message.customType === 'post-approval-continuation-started') throw new Error('progress display failed')
      sendMessages.push({ message, options: sendOptions })
    },
    sendUserMessage: (message: string) => sendUserMessages.push(message),
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
      if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') {
        trace.push('bd-comments-add')
        if (options.commentAddFails) return { stdout: '', stderr: 'comment write failed', code: 1 }
        return { stdout: '{"ok":true}', stderr: '', code: 0 }
      }
      if (command === 'git') {
        const cwd = args[0] === '-C' ? args[1] : undefined
        if (taskScopeGit) {
          if (cwd === '/tmp/task') {
            if (args.includes('branch')) return { stdout: 'task/plan-approved\n', stderr: '', code: 0 }
            if (args.includes('--show-toplevel')) return { stdout: '/tmp/task\n', stderr: '', code: 0 }
            if (args.includes('HEAD')) return { stdout: 'task123\n', stderr: '', code: 0 }
          }
          if (cwd === '/tmp/project') {
            if (args.includes('branch')) return { stdout: 'main\n', stderr: '', code: 0 }
            if (args.includes('--show-toplevel')) return { stdout: '/tmp/project\n', stderr: '', code: 0 }
            if (args.includes('HEAD')) return { stdout: 'abc123\n', stderr: '', code: 0 }
          }
          return { stdout: '', stderr: 'not a git repository', code: 128 }
        }
        if (args.includes('branch')) return { stdout: 'main\n', stderr: '', code: 0 }
        if (args.includes('--show-toplevel')) return { stdout: '/tmp/project\n', stderr: '', code: 0 }
        if (args.includes('HEAD')) return { stdout: 'abc123\n', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    },
    events: {
      emit: (name: string, event: any) => {
        if (name === 'workflow-state:update') {
          if (event.planApproved === true) trace.push('workflow-plan-approved')
          workflowUpdates.push(event)
          const previous = [...sessionEntries].reverse().find((entry) => entry.type === 'workflow-state' || entry.customType === 'workflow-state')
          const previousData = previous?.data && typeof previous.data === 'object' ? previous.data as Record<string, unknown> : {}
          const nextData: Record<string, unknown> = { ...previousData }
          for (const key of ['activeBead', 'branch', 'worktreePath', 'startCommit', 'planApproved', 'state', 'sessionMode', 'planMode']) {
            if (event[key] !== undefined) nextData[key] = event[key]
          }
          sessionEntries.push({ type: 'custom', customType: 'workflow-state', data: nextData })
        }
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
    sessionManager: { getSessionId: () => 'session-current', getEntries: () => sessionEntries },
    hasUI: true,
    ui: {
      notify() {},
      select: async () => 'Execute the plan',
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
  return { commandHandlers, toolHandlers, workflowUpdates, statuses, widgets, activeTools, inputHandlers, toolCallHandlers, agentEndHandlers, sessionStartHandlers, beforeAgentStartHandlers, sendMessages, sendUserMessages, execCalls, delayedClaimEvents, trace, sessionEntries, ctx }
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

  it('plan-mode idle does not coerce implementing non-terminal activeBead', async () => {
    const { sessionStartHandlers, commandHandlers, workflowUpdates, ctx } = makeHarness({
      entries: [{
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'bead-dbtg',
          state: 'implementing',
          sessionMode: 'implementing',
          branch: 'fix/dbtg-visible-cmux-cwd-state',
          worktreePath: '/tmp/task',
          startCommit: 'abc123',
          bdStatus: 'in_progress',
        },
      }],
    })

    await sessionStartHandlers[0]?.({}, ctx)
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off' })
    expect(workflowUpdates.at(-1)).not.toHaveProperty('sessionMode', 'idle')
    expect(workflowUpdates.at(-1)).not.toHaveProperty('state', 'idle')

    await commandHandlers.get('plan')?.handler('', ctx)
    await commandHandlers.get('plan-cancel')?.handler('', ctx)
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off' })
    expect(workflowUpdates.at(-1)).not.toHaveProperty('sessionMode', 'idle')
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
    expect(activeTools.at(-1)).toContain('plan_subagent')
    expect(activeTools.at(-1)).not.toContain('subagent')
    for (const mutatingWorkflowTool of ['dispatch_supervisor', 'dispatch_reviewer', 'dispatch_docs_agent', 'review_bead', 'workflow_submit_for_review', 'workflow_complete', ...hopWorkflowTools]) {
      expect(activeTools.at(-1)).not.toContain(mutatingWorkflowTool)
    }

    await toolHandlers.get('workflow_plan_mode')?.execute('call-2', { mode: 'off', reason: 'cancel' }, undefined, undefined, ctx)

    expect(workflowUpdates.at(-2)).toMatchObject({ planMode: 'strict', sessionMode: 'planning' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'idle' })
    expect(activeTools.at(-2)).toEqual(expectedPlanTools)
    expect(activeTools.at(-1)).toEqual(expectedNormalTools)
    expect(activeTools.at(-1)).toEqual(expect.arrayContaining(mandatoryWorkflowTools))
    expect(activeTools.at(-1)).toEqual(expect.arrayContaining(hopWorkflowTools))
  })

  it('restores hop tools after plan-mode off when prePlan active surface omitted them but getAllTools still registers them', async () => {
    const prePlanWithoutHops = expectedNormalTools.filter((name) => !hopWorkflowTools.includes(name))
    expect(prePlanWithoutHops).not.toEqual(expect.arrayContaining(hopWorkflowTools))

    const { toolHandlers, activeTools, ctx } = makeHarness({
      initialActiveTools: prePlanWithoutHops,
      // registered surface includes hop tools even though pre-plan active did not
      registeredTools: expectedNormalTools,
    })

    await toolHandlers.get('workflow_plan_mode')?.execute('call-1', { mode: 'strict', reason: 'plan first' }, undefined, undefined, ctx)
    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
    for (const hop of hopWorkflowTools) {
      expect(activeTools.at(-1)).not.toContain(hop)
    }

    await toolHandlers.get('workflow_plan_mode')?.execute('call-2', { mode: 'off', reason: 'cancel' }, undefined, undefined, ctx)

    const restored = activeTools.at(-1) ?? []
    expect(restored).toEqual(expect.arrayContaining(hopWorkflowTools))
    expect(restored).toEqual(expect.arrayContaining(mandatoryWorkflowTools))
    // Mandatory path must re-add hops, not merely replay the prePlan snapshot that lacked them.
    for (const hop of hopWorkflowTools) {
      expect(prePlanWithoutHops).not.toContain(hop)
      expect(restored).toContain(hop)
    }
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

  it('blocks generic subagent tool calls in plan mode before child execution', async () => {
    const { commandHandlers, toolCallHandlers, ctx } = makeHarness()

    await commandHandlers.get('plan')?.handler('', ctx)
    const decision = await toolCallHandlers[0]?.({ toolName: 'subagent', input: { agent: 'detective', task: 'negative smoke' } }, ctx) as { block: boolean, reason: string }

    expect(decision).toMatchObject({ block: true })
    expect(decision.reason).toContain('tool blocked')
    expect(decision.reason).toContain('generic subagent')
    expect(decision.reason).toContain('Tool: subagent')
  })

  it('blocks namespaced generic subagent tool calls in plan mode before child execution', async () => {
    const { commandHandlers, toolCallHandlers, ctx } = makeHarness()

    await commandHandlers.get('plan')?.handler('', ctx)
    const decision = await toolCallHandlers[0]?.({ toolName: 'functions.subagent', input: { agent: 'detective', task: 'negative smoke' } }, ctx) as { block: boolean, reason: string }

    expect(decision).toMatchObject({ block: true })
    expect(decision.reason).toContain('tool blocked')
    expect(decision.reason).toContain('Tool: functions.subagent')
  })

  it('does not block allowed plan_subagent tool calls in plan mode', async () => {
    const { commandHandlers, toolCallHandlers, ctx } = makeHarness()

    await commandHandlers.get('plan')?.handler('', ctx)
    const decision = await toolCallHandlers[0]?.({ toolName: 'plan_subagent', input: { agent: 'detective', task: 'read-only planning' } }, ctx)

    expect(decision).toBeUndefined()
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
    expect(ok.content[0].text).toContain('STOP_SHOW_USER')
    expect(ok.content[0].text).toContain('PLAN REVIEW: APPROVED')
    expect(ok.details).toMatchObject({ ok: true, cycle: 1, stopAdvice: 'STOP_SHOW_USER' })
    expect(blocked.content[0].text).toContain('HARD_BLOCK')
    expect(blocked.content[0].text).toContain('missing reviewer: plan-dead-zone-reviewer')
    expect(blocked.content[0].text).toContain('blocked reviewer: plan-consistency-reviewer')
    expect(blocked.details).toMatchObject({ ok: false, cycle: 2, stopAdvice: 'HARD_BLOCK' })
    expect(workflowUpdates).toHaveLength(beforeWorkflowUpdates)
    expect(execCalls).toHaveLength(beforeExecCalls)
    expect(source).toEqual(expect.stringContaining('MUST call workflow_plan_review'))
    expect(source).toEqual(expect.stringContaining('MUST NOT call workflow_plan_review'))
    expect(source).toEqual(expect.stringContaining('Accepted findings'))
    expect(source).toEqual(expect.stringContaining('Rejected findings'))
  })

  it('workflow_plan_review caps at 2 spawns: clean APPROVED stops without second spawn; important CONTINUE then STOP; empty no increment; third skips spawn', async () => {
    const { toolHandlers, beforeAgentStartHandlers, sessionEntries, ctx } = makeHarness()

    await toolHandlers.get('workflow_plan_mode')?.execute('call-setup', { mode: 'strict' }, undefined, undefined, ctx)

    const empty = await toolHandlers.get('workflow_plan_review')?.execute('call-empty', { draftPlan: '   ' }, undefined, undefined, ctx)
    expect(empty.details).toMatchObject({ ok: false, error: 'draftPlan is required' })
    expect(mockPlanReviewSpawnCount).toBe(0)

    const mustBefore = await beforeAgentStartHandlers[0]?.({}, ctx) as { message?: { content?: string } }
    expect(mustBefore?.message?.content).toContain('MUST call workflow_plan_review')
    expect(mustBefore?.message?.content).not.toContain('MUST NOT call workflow_plan_review')

    const clean = await toolHandlers.get('workflow_plan_review')?.execute('call-clean', {
      draftPlan: 'FAST_PATH_RATIONALE: docs-only\nPlan:\n1. Add one markdown file.\nFiles: docs/note.md',
    }, undefined, undefined, ctx)
    expect(mockPlanReviewSpawnCount).toBe(1)
    expect(clean.details).toMatchObject({ ok: true, cycle: 1, stopAdvice: 'STOP_SHOW_USER', risk: 'low' })
    expect(clean.content[0].text).toContain('STOP_SHOW_USER')
    expect(clean.content[0].text).toContain('MUST NOT call workflow_plan_review')

    const mustNotAfterClean = await beforeAgentStartHandlers[0]?.({}, ctx) as { message?: { content?: string } }
    expect(mustNotAfterClean?.message?.content).toContain('MUST NOT call workflow_plan_review')
    expect(mustNotAfterClean?.message?.content).not.toMatch(/you MUST call workflow_plan_review/i)

    // New session path for important-finding CONTINUE → STOP → skip third
    const harness2 = makeHarness()
    await harness2.toolHandlers.get('workflow_plan_mode')?.execute('call-setup-2', { mode: 'strict' }, undefined, undefined, harness2.ctx)
    mockPlanReviewImportantFindings = [{
      severity: 'important',
      issue: 'missing rollback',
      evidence: 'plan omits rollback',
      suggestedFix: 'add rollback',
    }]
    mockPlanReviewResults = defaultMockPlanReviewResults().map((result, index) => index === 0
      ? {
          ...result,
          verdict: 'NEEDS_CHANGES',
          findings: mockPlanReviewImportantFindings,
          raw: 'PLAN REVIEW: NEEDS_CHANGES',
        }
      : result)

    const continueResult = await harness2.toolHandlers.get('workflow_plan_review')?.execute('call-important-1', {
      draftPlan: 'Plan:\n1. Change workflow policy.\nFiles: .pi/extensions/plan-mode/index.ts',
    }, undefined, undefined, harness2.ctx)
    expect(continueResult.details).toMatchObject({ ok: true, cycle: 1, stopAdvice: 'CONTINUE', risk: 'high' })
    expect(continueResult.content[0].text).toContain('CONTINUE')
    expect(mockPlanReviewSpawnCount).toBe(1)

    const mustContinue = await harness2.beforeAgentStartHandlers[0]?.({}, harness2.ctx) as { message?: { content?: string } }
    expect(mustContinue?.message?.content).toContain('MUST call workflow_plan_review')
    expect(mustContinue?.message?.content).not.toContain('MUST NOT call workflow_plan_review')

    const stopAtTwo = await harness2.toolHandlers.get('workflow_plan_review')?.execute('call-important-2', {
      draftPlan: 'Plan:\n1. Change workflow policy.\nFiles: .pi/extensions/plan-mode/index.ts',
    }, undefined, undefined, harness2.ctx)
    expect(stopAtTwo.details).toMatchObject({ ok: true, cycle: 2, stopAdvice: 'STOP_SHOW_USER' })
    expect(mockPlanReviewSpawnCount).toBe(2)

    const skipThird = await harness2.toolHandlers.get('workflow_plan_review')?.execute('call-important-3', {
      draftPlan: 'Plan:\n1. Change workflow policy.\nFiles: .pi/extensions/plan-mode/index.ts',
    }, undefined, undefined, harness2.ctx)
    expect(skipThird.details).toMatchObject({ ok: true, cycle: 2, stopAdvice: 'STOP_SHOW_USER', skippedSpawn: true })
    expect(mockPlanReviewSpawnCount).toBe(2)
    expect(skipThird.content[0].text).toContain('No additional reviewer spawn')

    const mustNotAfterCap = await harness2.beforeAgentStartHandlers[0]?.({}, harness2.ctx) as { message?: { content?: string } }
    expect(mustNotAfterCap?.message?.content).toContain('MUST NOT call workflow_plan_review')
    expect(mustNotAfterCap?.message?.content).not.toMatch(/you MUST call workflow_plan_review/i)

    // Persist cycle fields on appendEntry
    const persisted = sessionEntries.filter((entry) => entry.customType === 'plan-mode').at(-1)
    expect(persisted?.data).toMatchObject({ planReviewCycleCount: 1, lastPlanReviewStopAdvice: 'STOP_SHOW_USER' })
  })

  it('workflow_plan_review persists/restores cycle state, does not reset on repeated plan_mode, failed spawn consumes slot, overlap ≤2', async () => {
    const { toolHandlers, sessionStartHandlers, sessionEntries, ctx } = makeHarness()

    await toolHandlers.get('workflow_plan_mode')?.execute('call-on', { mode: 'strict' }, undefined, undefined, ctx)
    mockPlanReviewImportantFindings = [{
      severity: 'important',
      issue: 'gap',
      evidence: 'plan',
      suggestedFix: 'fix',
    }]
    const first = await toolHandlers.get('workflow_plan_review')?.execute('call-1', { draftPlan: 'Plan:\n1. Keep important finding.' }, undefined, undefined, ctx)
    expect(first.details).toMatchObject({ cycle: 1, stopAdvice: 'CONTINUE' })

    // Repeated enable while already on must not reset cycle.
    await toolHandlers.get('workflow_plan_mode')?.execute('call-again', { mode: 'strict' }, undefined, undefined, ctx)
    const second = await toolHandlers.get('workflow_plan_review')?.execute('call-2', { draftPlan: 'Plan:\n1. Keep important finding.' }, undefined, undefined, ctx)
    expect(second.details).toMatchObject({ cycle: 2, stopAdvice: 'STOP_SHOW_USER' })

    const persisted = sessionEntries.filter((entry) => entry.customType === 'plan-mode').at(-1)
    expect(persisted?.data).toMatchObject({
      enabled: true,
      planReviewCycleCount: 2,
      lastPlanReviewStopAdvice: 'STOP_SHOW_USER',
    })

    // Restore into a fresh extension instance via session_start entries.
    const restored = makeHarness({
      entries: [
        { type: 'custom', customType: 'workflow-state', data: { activeBead: 'bead-plan', branch: 'task/plan-approved', worktreePath: '/tmp/task', startCommit: 'task123' } },
        {
          type: 'custom',
          customType: 'plan-mode',
          data: {
            enabled: true,
            autoExecute: false,
            autopilot: false,
            todos: [],
            executing: false,
            autoPlanReviewState: 'idle',
            autoPlanReviewResults: [],
            planReviewCycleCount: 2,
            lastPlanReviewStopAdvice: 'STOP_SHOW_USER',
            lastPlanReviewResults: defaultMockPlanReviewResults(),
          },
        },
      ],
    })
    await restored.sessionStartHandlers[0]?.({}, restored.ctx)
    const afterRestore = await restored.toolHandlers.get('workflow_plan_review')?.execute('call-restored', {
      draftPlan: 'Plan:\n1. After restore.',
    }, undefined, undefined, restored.ctx)
    expect(afterRestore.details).toMatchObject({ cycle: 2, stopAdvice: 'STOP_SHOW_USER', skippedSpawn: true })
    expect(mockPlanReviewSpawnCount).toBe(0)

    // Failed spawn still consumes a cycle slot.
    const failHarness = makeHarness()
    await failHarness.toolHandlers.get('workflow_plan_mode')?.execute('call-fail-on', { mode: 'strict' }, undefined, undefined, failHarness.ctx)
    mockPlanReviewSpawnError = new Error('spawn exploded')
    const failed = await failHarness.toolHandlers.get('workflow_plan_review')?.execute('call-fail', {
      draftPlan: 'Plan:\n1. Fail closed spawn.',
    }, undefined, undefined, failHarness.ctx)
    expect(failed.details).toMatchObject({ ok: false, cycle: 1, stopAdvice: 'HARD_BLOCK' })
    expect(mockPlanReviewSpawnCount).toBe(1)

    // Overlap: two concurrent calls reserve distinct slots up to max 2.
    const overlap = makeHarness()
    await overlap.toolHandlers.get('workflow_plan_mode')?.execute('call-overlap-on', { mode: 'strict' }, undefined, undefined, overlap.ctx)
    mockPlanReviewSpawnError = undefined
    let releaseOverlap!: () => void
    mockPlanReviewSpawnGate = new Promise<void>((resolve) => { releaseOverlap = resolve })
    const p1 = overlap.toolHandlers.get('workflow_plan_review')?.execute('overlap-1', { draftPlan: 'Plan:\n1. Overlap A.' }, undefined, undefined, overlap.ctx)
    const p2 = overlap.toolHandlers.get('workflow_plan_review')?.execute('overlap-2', { draftPlan: 'Plan:\n1. Overlap B.' }, undefined, undefined, overlap.ctx)
    // Allow both to reserve before spawn resolves.
    await Promise.resolve()
    releaseOverlap()
    const [r1, r2] = await Promise.all([p1, p2])
    expect([r1.details.cycle, r2.details.cycle].sort()).toEqual([1, 2])
    expect(mockPlanReviewSpawnCount).toBe(2)
    const p3 = await overlap.toolHandlers.get('workflow_plan_review')?.execute('overlap-3', { draftPlan: 'Plan:\n1. Overlap C.' }, undefined, undefined, overlap.ctx)
    expect(p3.details).toMatchObject({ cycle: 2, skippedSpawn: true })
    expect(mockPlanReviewSpawnCount).toBe(2)
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
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).toBe('/tmp/task')
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
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
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).toBe('/tmp/task')
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
  })

  it('workflow_plan_approved normalizes markdown list/backtick worktree evidence before validation', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({ taskScopeGit: true })

    const approved = await toolHandlers.get('workflow_plan_approved')?.execute('call-markdown-worktree', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: continue in the approved task worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow state keeps task scope.',
        'Branch: task/plan-approved',
        'Worktree / cwd:',
        '- `/tmp/task`',
        'START_COMMIT: task123',
      ].join('\n'),
    }, undefined, undefined, ctx)

    const commentCall = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(approved.content[0].text).toContain('workflow_plan_approved recorded')
    expect(commentCall?.args[3]).toContain('WORKTREE: /tmp/task')
    expect(commentCall?.args[3]).not.toContain('WORKTREE: -')
    expect(workflowUpdates.at(-1)).toMatchObject({ branch: 'task/plan-approved', worktreePath: '/tmp/task', startCommit: 'task123', planApproved: true })
  })

  async function approveWithEvidence(toolHandlers: Map<string, any>, ctx: any, callId: string, evidence: string[]) {
    return toolHandlers.get('workflow_plan_approved')?.execute(callId, {
      beadId: 'bead-plan',
      planEvidence: evidence.join('\n'),
    }, undefined, undefined, ctx)
  }

  function worktreeCommentHeader(execCalls: Array<{ command: string, args: string[] }>): string | undefined {
    const commentCall = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    return String(commentCall?.args[3] ?? '').split('\n').find((line) => line.startsWith('WORKTREE:'))
  }

  it('workflow_plan_approved sanitizes Worktree backtick path with trailing (created) note', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({ taskScopeGit: true })
    const approved = await approveWithEvidence(toolHandlers, ctx, 'call-worktree-created-note', [
      'Plan: continue in the approved task worktree.',
      'Files: .pi/extensions/plan-mode/index.ts.',
      'Acceptance: workflow state keeps task scope.',
      'Branch: task/plan-approved',
      'Worktree: `/tmp/task` (created)',
      'START_COMMIT: task123',
    ])
    expect(approved.content[0].text).toContain('workflow_plan_approved recorded')
    expect(worktreeCommentHeader(execCalls)).toBe('WORKTREE: /tmp/task')
    expect(workflowUpdates.at(-1)).toMatchObject({ branch: 'task/plan-approved', worktreePath: '/tmp/task', startCommit: 'task123', planApproved: true })
  })

  it('workflow_plan_approved sanitizes Worktree / cwd next-line list noisy path with trailing note', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({ taskScopeGit: true })
    const approved = await approveWithEvidence(toolHandlers, ctx, 'call-worktree-list-created-note', [
      'Plan: continue in the approved task worktree.',
      'Files: .pi/extensions/plan-mode/index.ts.',
      'Acceptance: workflow state keeps task scope.',
      'Branch: task/plan-approved',
      'Worktree / cwd:',
      '- `/tmp/task` (already created)',
      'START_COMMIT: task123',
    ])
    expect(approved.content[0].text).toContain('workflow_plan_approved recorded')
    expect(worktreeCommentHeader(execCalls)).toBe('WORKTREE: /tmp/task')
    expect(workflowUpdates.at(-1)).toMatchObject({ branch: 'task/plan-approved', worktreePath: '/tmp/task', startCommit: 'task123', planApproved: true })
  })

  it('workflow_plan_approved blocks missing sanitized noisy worktree with clean recovery path', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({ taskScopeGit: true })
    const blocked = await approveWithEvidence(toolHandlers, ctx, 'call-missing-noisy-worktree', [
      'Plan: continue in the approved task worktree.',
      'Files: .pi/extensions/plan-mode/index.ts.',
      'Acceptance: workflow state keeps task scope.',
      'Branch: task/plan-approved',
      'Worktree: `/tmp/missing` (created)',
    ])
    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('not a readable git worktree')
    expect(blocked.content[0].text).toContain('bd worktree create /tmp/missing --branch task/plan-approved')
    expect(blocked.content[0].text).not.toContain('(created)')
    expect(blocked.content[0].text).not.toContain('`/tmp/missing`')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
  })

  it('workflow_plan_approved blocks normalized invalid explicit evidence worktree without bd comment, state update, or continuation', async () => {
    const { toolHandlers, workflowUpdates, execCalls, sendMessages, sendUserMessages, ctx } = makeHarness({ taskScopeGit: true })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-invalid-markdown-worktree', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: continue in the approved task worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow state keeps task scope.',
        'Branch: task/plan-approved',
        'Worktree / cwd:',
        '- `/tmp/missing`',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('not a readable git worktree')
    expect(blocked.content[0].text).toContain('bd worktree create /tmp/missing --branch task/plan-approved')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
    expect(sendMessages.some((message) => message.message.customType === 'plan-mode-execute')).toBe(false)
    expect(sendUserMessages).toHaveLength(0)
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
    expect(blocked.content[0].text).toContain('bd worktree create /tmp/missing --branch task/plan-approved')
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
    expect(blocked.content[0].text).toContain('bd worktree create /tmp/task --branch task/wrong')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
  })

  it('workflow_plan_approved preserves recorded task worktree scope when ctx cwd is main', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({
      taskScopeGit: true,
      entries: [{
        type: 'workflow-state',
        data: {
          activeBead: 'bead-plan',
          branch: 'task/plan-approved',
          worktreePath: '/tmp/task',
          startCommit: 'task123',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
        },
      }],
    })

    const approved = await toolHandlers.get('workflow_plan_approved')?.execute('call-recorded-task-scope', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: continue using the recorded workflow-state task worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow state keeps task scope.',
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
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).toBe('/tmp/task')
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
  })

  it('workflow_plan_approved blocks when no recorded task worktree scope exists instead of falling back to ctx cwd', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({ entries: [] })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-ctx-fallback', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: approve without a recorded task worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow approval blocks missing task worktree.',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('bd worktree create')
    expect(blocked.content[0].text).not.toMatch(/PLAN APPROVED/)
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
    expect(mockSupervisorDispatchCalls).toHaveLength(0)
  })

  it('workflow_plan_approved blocks recorded branch scope without worktree before bd comment', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({
      entries: [{ type: 'workflow-state', data: { activeBead: 'bead-plan', branch: 'task/plan-approved', sessionKey: 'id:session-current' } }],
    })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-recorded-incomplete-scope', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: reject incomplete recorded scope.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow approval blocks ambiguous scope.',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('no worktreePath')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
  })

  it('workflow_plan_approved blocks recorded invalid task worktree before bd comment', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({
      taskScopeGit: true,
      entries: [{ type: 'workflow-state', data: { activeBead: 'bead-plan', branch: 'task/plan-approved', worktreePath: '/tmp/missing', sessionKey: 'id:session-current' } }],
    })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-recorded-invalid-scope', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: reject invalid recorded worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow approval blocks invalid scope.',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('recorded workflow-state worktree is not a readable git worktree')
    expect(blocked.content[0].text).toContain('bd worktree create /tmp/missing --branch task/plan-approved')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
  })

  it('workflow_plan_approved blocks recorded protected main branch without dispatch or PLAN APPROVED comment', async () => {
    const { toolHandlers, workflowUpdates, execCalls, sendMessages, ctx } = makeHarness({
      entries: [{ type: 'workflow-state', data: { activeBead: 'bead-plan', branch: 'main', worktreePath: '/tmp/project', sessionKey: 'id:session-current' } }],
    })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-recorded-main', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: reject protected recorded main worktree.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: workflow approval blocks protected main.',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('bd worktree create')
    expect(blocked.content[0].text).not.toContain('--branch main')
    expect(blocked.content[0].text).not.toMatch(/PLAN APPROVED/)
    expect(blocked.content[0].text).not.toContain('runtime hook missing')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
    expect(mockSupervisorDispatchCalls).toHaveLength(0)
    expect(sendMessages).toHaveLength(0)
  })

  it('explicit evidence cwd on main does not bypass the guard when recorded scope is also main', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({
      entries: [{ type: 'workflow-state', data: { activeBead: 'bead-plan', branch: 'main', worktreePath: '/tmp/project', sessionKey: 'id:session-current' } }],
    })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-arg-main-recorded-main', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: reject explicit main checkout cwd.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: explicit cwd=main does not bypass the guard.',
        'Branch: main',
        'Worktree: /tmp/project',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('bd worktree create')
    expect(blocked.content[0].text).not.toContain('--branch main')
    expect(blocked.content[0].text).not.toMatch(/PLAN APPROVED/)
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
    expect(mockSupervisorDispatchCalls).toHaveLength(0)
  })

  it('explicit evidence cwd on main does not win over a recorded task worktree', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({
      taskScopeGit: true,
      entries: [{
        type: 'workflow-state',
        data: {
          activeBead: 'bead-plan',
          branch: 'task/plan-approved',
          worktreePath: '/tmp/task',
          startCommit: 'task123',
          sessionKey: 'id:session-current',
          runtimeOwnerKey: currentRuntimeOwnerKey(),
        },
      }],
    })

    const approved = await toolHandlers.get('workflow_plan_approved')?.execute('call-arg-main-recorded-task', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: continue using recorded task worktree even if evidence names main.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: dispatch uses recorded task worktree.',
        'Branch: main',
        'Worktree: /tmp/project',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(approved.content[0].text).toContain('workflow_plan_approved recorded')
    expect(execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')?.args[3]).toContain('WORKTREE: /tmp/task')
    expect(workflowUpdates.at(-1)).toMatchObject({ worktreePath: '/tmp/task', branch: 'task/plan-approved' })
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).toBe('/tmp/task')
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
  })

  it('UI Execute writes durable PLAN APPROVED comment and shows started/running progress before dispatch resolves', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, workflowUpdates, execCalls, trace, statuses, widgets, ctx } = makeHarness({ activeBead: 'bead-ui' })
    let releaseDispatch!: () => void
    mockSupervisorDispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve })

    await commandHandlers.get('plan')?.handler('', ctx)
    const execution = agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement durable approval.\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- vitest passes' }] }] }, ctx) as Promise<void>
    for (let i = 0; i < 10 && mockSupervisorDispatchCalls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0))

    const commentCallIndex = execCalls.findIndex((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    const approvedUpdateIndex = workflowUpdates.findIndex((update: any) => update.planApproved === true)
    const comment = execCalls[commentCallIndex]?.args[3] ?? ''
    const startedMessage = sendMessages.find((message) => message.message.customType === 'post-approval-continuation-started')
    expect(commentCallIndex).toBeGreaterThanOrEqual(0)
    expect(approvedUpdateIndex).toBeGreaterThanOrEqual(0)
    expect(trace.indexOf('bd-comments-add')).toBeLessThan(trace.indexOf('workflow-plan-approved'))
    expect(execCalls[commentCallIndex]?.args[2]).toBe('bead-ui')
    expect(comment).toContain('PLAN APPROVED')
    expect(comment).toContain('Approved-by: Максим')
    expect(comment).toContain('START_COMMIT: task123')
    expect(comment).toContain('Files to change:')
    expect(comment).toContain('Acceptance:')
    expect(comment).toContain('Verification / acceptance checks:')
    expect(workflowUpdates.at(-1)).toMatchObject({ activeBead: 'bead-ui', planMode: 'off', sessionMode: 'implementing', planApproved: true })
    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-ui', cwd: '/tmp/task' })
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
    expect(startedMessage?.message.content).toContain('PLAN APPROVED: продолжение запущено')
    expect(startedMessage?.message.content).toContain('Bead: bead-ui')
    expect(startedMessage?.message.content).toContain('State: started/running')
    expect(startedMessage?.message.content).toContain('Next typed action: dispatch_supervisor(beadId=bead-ui, cwd=/tmp/task)')
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation')).toBe(false)

    releaseDispatch()
    await execution

    expect(sendMessages.at(-1)?.message.customType).toBe('post-approval-continuation')
    expect(sendMessages.at(-1)?.message.content).toContain('PLAN APPROVED continuation completed')
    expect(sendMessages.some((message) => message.message.customType === 'plan-todo-list')).toBe(false)
    expect(statuses['plan-mode']).toBeUndefined()
    expect(widgets['plan-todos']).toBeUndefined()
  })

  it('UI Execute records an immediate runtime-hook blocker when typed continuation API is unavailable', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, workflowUpdates, execCalls, ctx } = makeHarness({ activeBead: 'bead-ui' })
    mockSupervisorDispatchAvailable = false

    await commandHandlers.get('plan')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement durable approval.\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- vitest passes' }] }] }, ctx)

    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments[0]?.args[3]).toContain('PLAN APPROVED')
    expect(comments[1]?.args[3]).toContain('BLOCKED: runtime hook missing')
    expect(comments[1]?.args[3]).not.toMatch(/PLAN APPROVED/)
    expect(workflowUpdates.at(-1)).toMatchObject({ activeBead: 'bead-ui', sessionMode: 'blocked', planApproved: true })
    expect(sendMessages.find((message) => message.message.customType === 'post-approval-continuation-started')?.message.content).toContain('Next typed action: dispatch_supervisor(beadId=bead-ui, cwd=/tmp/task)')
    expect(sendMessages.find((message) => message.message.customType === 'post-approval-continuation-started')?.message.content).not.toContain('cwd=/tmp/project')
    expect(sendMessages.at(-1)?.message.customType).toBe('post-approval-continuation-blocked')
    expect(sendMessages.at(-1)?.message.content).toContain('не silent stall')
    expect(sendMessages.at(-1)?.message.content).not.toMatch(/PLAN APPROVED/)
  })

  it('does not treat cmux spawn-ack as continuation completed', async () => {
    mockSupervisorDispatchSpawned = true
    const { commandHandlers, agentEndHandlers, sendMessages, ctx } = makeHarness({ activeBead: 'bead-ui' })
    mockSupervisorDispatchSpawned = true

    await commandHandlers.get('plan')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement durable approval.\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- vitest passes' }] }] }, ctx)

    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-ui', cwd: '/tmp/task', transport: 'cmux' })
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe('/Users/maksimposudevskiy/Projects/beads-task-issue-tracker')
    expect(sendMessages.at(-1)?.message.content).toContain('supervisor spawned, waiting ping')
    expect(sendMessages.at(-1)?.message.content).not.toContain('PLAN APPROVED continuation completed')
  })

  it('continues dispatch when best-effort pre-dispatch progress message cannot be displayed', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, ctx } = makeHarness({ activeBead: 'bead-ui', failPreDispatchProgressMessage: true })

    await commandHandlers.get('plan')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement durable approval.\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- vitest passes' }] }] }, ctx)

    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-ui', cwd: '/tmp/task' })
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation-started')).toBe(false)
    expect(sendMessages.at(-1)?.message.customType).toBe('post-approval-continuation')
    expect(sendMessages.at(-1)?.message.content).toContain('PLAN APPROVED continuation completed')
  })

  it('UI Execute blocks missing explicit worktree before durable comment or planApproved state', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, workflowUpdates, execCalls, ctx } = makeHarness({ activeBead: 'bead-ui', taskScopeGit: true })

    await commandHandlers.get('plan')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: [
      'Plan:\n1. Implement durable approval.',
      'Files to change:\n- .pi/extensions/plan-mode/index.ts',
      'Acceptance:\n- vitest passes',
      'BRANCH: task/plan-approved',
      'Worktree / cwd:',
      '- `/tmp/missing`',
    ].join('\n') }] }] }, ctx)

    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-ui']) }),
    ]))
    expect(workflowUpdates.some((update: any) => update.planApproved === true)).toBe(false)
    expect(sendMessages.at(-1)?.message.customType).toBe('plan-approval-recovery')
    expect(sendMessages.at(-1)?.message.content).toContain('durable `PLAN APPROVED` comment не записан')
    expect(sendMessages.at(-1)?.message.content).toContain('bd worktree create /tmp/missing --branch task/plan-approved')
    expect(mockSupervisorDispatchCalls).toHaveLength(0)
  })

  it('UI Execute does not set planApproved=true when durable PLAN APPROVED comment fails', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, workflowUpdates, execCalls, activeTools, ctx } = makeHarness({ activeBead: 'bead-ui', commentAddFails: true })

    await commandHandlers.get('plan')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement durable approval.\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- vitest passes' }] }] }, ctx)

    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')).toBe(true)
    expect(workflowUpdates.some((update: any) => update.planApproved === true)).toBe(false)
    expect(workflowUpdates.at(-1)).toMatchObject({ activeBead: 'bead-ui', sessionMode: 'blocked', planApproved: false })
    expect(sendMessages.at(-1)?.message.customType).toBe('plan-approval-recovery')
    expect(sendMessages.at(-1)?.message.content).toContain('workflow_plan_approved')
    expect(sendMessages.some((message) => message.message.customType === 'plan-mode-execute')).toBe(false)
    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
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

    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-plan', cwd: '/tmp/task' })
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
    expect(sendMessages.at(-1)?.message.customType).toBe('post-approval-continuation')
    expect(sendMessages.some((message) => message.message.customType === 'plan-todo-list')).toBe(false)
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'implementing', planApproved: true })
    expect(activeTools.at(-1)).toEqual(expectedNormalTools)
    expect(activeTools.at(-1)).toEqual(expect.arrayContaining(mandatoryWorkflowTools))
  })

  it('/plan-auto still records Approved-by: Максим and does not set AUTOPILOT', async () => {
    const { commandHandlers, agentEndHandlers, execCalls, statuses, ctx } = makeHarness()

    await commandHandlers.get('plan-auto')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft gate' }] }] }, ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: `Reviewer findings summary:\n- reviewers approved\nAccepted findings:\n- none\nRejected findings:\n- none\nUnresolved blockers: none\nRevised plan:\n1. Implement gate\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- tests pass\nRisks / rollback:\n- revert\nAUTO_EXECUTE_ALLOWED: true` }] }] }, ctx)

    const comment = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')?.args[3] ?? ''
    expect(comment).toContain('Approved-by: Максим')
    expect(comment).not.toContain('Approved-by: оркестратор')
    expect(comment).not.toContain('AUTOPILOT: true')
    expect(statuses['plan-mode']).toBeUndefined()
  })

  it('registers /plan-autopilot separately from /plan-auto', async () => {
    const { commandHandlers, workflowUpdates, statuses, ctx } = makeHarness()

    expect(commandHandlers.has('plan-autopilot')).toBe(true)
    expect(commandHandlers.has('plan-auto')).toBe(true)
    await commandHandlers.get('plan-autopilot')?.handler('', ctx)

    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'auto', sessionMode: 'planning' })
    expect(statuses['plan-mode']).toBe('⏸ plan-autopilot')
  })

  it('NL «работаю автономно» / «работать автономно» enters autopilot; questions and negations do not', async () => {
    for (const phrase of ['работаю автономно', 'работать автономно', 'Work autonomously']) {
      const { inputHandlers, workflowUpdates, statuses, ctx } = makeHarness()
      const result = await inputHandlers[0]?.({ text: phrase, source: 'user' }, ctx)
      expect(result).toEqual({ action: 'handled' })
      expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'auto', sessionMode: 'planning' })
      expect(statuses['plan-mode']).toBe('⏸ plan-autopilot')
    }

    const { commandHandlers, inputHandlers, workflowUpdates, statuses, ctx } = makeHarness()
    await commandHandlers.get('plan')?.handler('', ctx)
    const autoUpdatesBefore = workflowUpdates.filter((update: any) => update.planMode === 'auto').length
    expect(await inputHandlers[0]?.({ text: 'можно ли работать автономно?', source: 'user' }, ctx)).toBeUndefined()
    expect(await inputHandlers[0]?.({ text: 'не работай автономно', source: 'user' }, ctx)).toBeUndefined()
    expect(statuses['plan-mode']).toBe('⏸ plan')
    expect(workflowUpdates.filter((update: any) => update.planMode === 'auto')).toHaveLength(autoUpdatesBefore)
  })

  it('/plan-autopilot runs plan-review gate and records Approved-by: оркестратор; autopilot flag survives plan=off', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, activeTools, workflowUpdates, execCalls, statuses, ctx } = makeHarness()

    await commandHandlers.get('plan-autopilot')?.handler('', ctx)
    expect(statuses['plan-mode']).toBe('⏸ plan-autopilot')

    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft gate' }] }] }, ctx)
    expect(sendMessages.at(-1)?.message.customType).toBe('plan-review-findings')

    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: `Reviewer findings summary:\n- reviewers approved\nAccepted findings:\n- none\nRejected findings:\n- none\nUnresolved blockers: none\nRevised plan:\n1. Implement gate\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- tests pass\nRisks / rollback:\n- revert\nAUTO_EXECUTE_ALLOWED: true` }] }] }, ctx)

    const comment = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')?.args[3] ?? ''
    expect(comment).toContain('PLAN APPROVED')
    expect(comment).toContain('Approved-by: оркестратор')
    expect(comment).toContain('AUTOPILOT: true')
    expect(comment).not.toContain('Approved-by: Максим')
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'implementing', planApproved: true })
    expect(activeTools.at(-1)).toEqual(expectedNormalTools)
    expect(statuses['plan-mode']).toBe('autopilot')
    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-plan', cwd: '/tmp/task' })
  })

  it('/plan-autopilot blocks like /plan-auto when a required reviewer blocks the gate', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, activeTools, execCalls, ctx } = makeHarness()
    mockPlanReviewGateOk = false
    mockPlanReviewReasons = ['blocked reviewer: plan-dead-zone-reviewer']

    await commandHandlers.get('plan-autopilot')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Implement gate' }] }] }, ctx)

    expect(sendMessages.at(-1)?.message.customType).toBe('plan-review-gate-blocked')
    expect(sendMessages.at(-1)?.message.content).toContain('blocked reviewer: plan-dead-zone-reviewer')
    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')).toBe(false)
  })

  it('workflow_plan_mode(mode=autopilot) matches /plan-autopilot entry', async () => {
    const { toolHandlers, workflowUpdates, statuses, ctx } = makeHarness()

    const result = await toolHandlers.get('workflow_plan_mode')?.execute('call-autopilot', { mode: 'autopilot' }, undefined, undefined, ctx)
    expect(result.content[0].text).toContain('workflow_plan_mode=autopilot')
    expect(result.details).toMatchObject({ mode: 'autopilot', autopilot: true })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'auto', sessionMode: 'planning' })
    expect(statuses['plan-mode']).toBe('⏸ plan-autopilot')
  })

  it('documents autopilot stop contract separately from /plan-auto in README', () => {
    const readme = readFileSync(resolve(__dirname, '../../.pi/extensions/plan-mode/README.md'), 'utf8')
    expect(readme).toContain('/plan-autopilot')
    expect(readme).toContain('Approved-by: оркестратор')
    expect(readme).toContain('работаю автономно')
    expect(readme).toContain('NOT APPROVED')
    expect(readme).toContain('land')
    expect(readme).toContain('runtime hop')
    expect(readme).toContain('единственный consumer')
    expect(readme).toMatch(/\/plan-auto.*Does \*\*not\*\* close the bead/s)
  })

  async function enterAutopilotPlanOff(harness: ReturnType<typeof makeHarness>) {
    await harness.commandHandlers.get('plan-autopilot')?.handler('', harness.ctx)
    await harness.agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft gate' }] }] }, harness.ctx)
    await harness.agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: `Reviewer findings summary:\n- ok\nAccepted findings:\n- none\nRejected findings:\n- none\nUnresolved blockers: none\nRevised plan:\n1. Implement\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- tests pass\nRisks / rollback:\n- revert\nAUTO_EXECUTE_ALLOWED: true` }] }] }, harness.ctx)
    expect(harness.statuses['plan-mode']).toBe('autopilot')
  }

  function hopMessages(harness: ReturnType<typeof makeHarness>) {
    return harness.sendMessages.filter((m) => {
      const type = m.message.customType
      return type === 'autopilot-hop' || type === 'autopilot-hop-stop'
    })
  }

  function hopContents(harness: ReturnType<typeof makeHarness>) {
    return hopMessages(harness).map((m) => String(m.message.content))
  }

  it('autopilot+plan off consumes supervisor ping once and dispatches reviewer with human RU', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'submitted', text: 'SUPERVISOR ARTIFACT\nStatus: DONE\nArtifact status: complete' }

    const result = await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] test-supervisor · задача task-sup завершена taskId=task-sup digest=x',
    }, harness.ctx)

    expect(result).toEqual({ action: 'handled' })
    expect(mockCompleteVisibleCalls).toEqual([{ taskId: 'task-sup' }])
    expect(mockReviewerDispatchCalls).toEqual([{ beadId: 'bead-plan', cwd: '/tmp/task', transport: 'cmux' }])
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    const content = String(hops[0]?.message.content)
    expect(content).toContain('Пинг hop уже забрал')
    expect(content).toContain('code-reviewer')
    expect(content).toContain('ждать [PING] Максиму не нужно')
    expect(content).not.toContain('complete_visible_dispatch')
    expect(content).not.toContain('SUPERVISOR ARTIFACT')
    expect(content).not.toContain('status=')
  })

  it('result-only hop: human RU, ping consumed, not review-ready, no dump', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = {
      status: 'result-only',
      text: 'SUPERVISOR ARTIFACT\nStatus: DONE\nArtifact status: incomplete\n' + 'X'.repeat(400),
    }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] test-supervisor · задача task-sup завершена taskId=task-sup',
    }, harness.ctx)

    expect(mockCompleteVisibleCalls).toHaveLength(1)
    expect(mockReviewerDispatchCalls).toHaveLength(0)
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop')
    const content = String(hops[0]?.message.content)
    expect(content).not.toContain('result-only')
    expect(content).toContain('Пинг hop уже забрал')
    expect(content).toContain('к ревью он ещё не готов')
    expect(content).toContain('Ждать [PING] Максиму не нужно')
    expect(content).toContain('Это не «шаг закрыт» и не «работа закончена»')
    expect(content).not.toContain('complete_visible_dispatch')
    expect(content).not.toContain('SUPERVISOR ARTIFACT')
    expect(content).not.toContain('XXXX')
    expect(content).toContain('taskId: task-sup')
  })

  it('incomplete hop: distinct human copy, ping consumed, next ping from child', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'incomplete', text: 'still writing artifact' }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] test-supervisor · задача task-sup завершена taskId=task-sup',
    }, harness.ctx)

    expect(mockReviewerDispatchCalls).toHaveLength(0)
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    const content = String(hops[0]?.message.content)
    expect(content).not.toContain('incomplete')
    expect(content).toContain('ещё не готов')
    expect(content).toContain('Пинг hop уже забрал')
    expect(content).toContain('Ждать [PING] Максиму не нужно')
    expect(content).toContain('следующий [PING]')
    expect(content).not.toContain('complete_visible_dispatch')
    expect(content).not.toContain('result-only')
  })

  it('autopilot hop does not dispatch a second reviewer when one is already live', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'submitted', text: 'Status: DONE' }
    mockLiveRegistryByBead = { 'bead-plan': [{ entry: { role: 'code-reviewer', status: 'spawned' } }] }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] test-supervisor · задача task-sup завершена taskId=task-sup',
    }, harness.ctx)

    expect(mockCompleteVisibleCalls).toHaveLength(1)
    expect(mockReviewerDispatchCalls).toHaveLength(0)
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    const content = String(hops[0]?.message.content)
    expect(content).toMatch(/Live reviewer|live reviewer/i)
    expect(content).not.toContain('complete_visible_dispatch')
    expect(content).toContain('Ждать [PING] Максиму не нужно')
  })

  it('repeat ping after submitted/verdict is noop without second reviewer', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'noop', text: 'already submitted' }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] test-supervisor · задача task-sup завершена taskId=task-sup',
    }, harness.ctx)

    expect(mockCompleteVisibleCalls).toHaveLength(1)
    expect(mockReviewerDispatchCalls).toHaveLength(0)
    expect(mockFinalizeCloseCalls).toHaveLength(0)
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    const content = String(hops[0]?.message.content)
    expect(content).toContain('уже был зафиксирован')
    expect(content).not.toContain('complete_visible_dispatch')
    expect(content).toContain('Ждать [PING] не нужно')
  })

  it('reviewer APPROVED hop closes bead with one human success message and clears autopilot', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'verdict', text: 'CODE REVIEW: APPROVED' }
    mockFinalizeCloseResult = { ok: true, status: 'closed', text: 'closed bead-plan' }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] code-reviewer · задача task-rev завершена taskId=task-rev',
    }, harness.ctx)

    expect(mockCompleteVisibleCalls).toEqual([{ taskId: 'task-rev' }])
    expect(mockFinalizeCloseCalls).toEqual([{ beadId: 'bead-plan', worktreePath: '/tmp/task', startCommit: 'task123' }])
    expect(mockCloseVisibleCalls).toEqual([{ beadId: 'bead-plan' }])
    expect(harness.statuses['plan-mode']).toBeUndefined()
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop')
    const content = String(hops[0]?.message.content)
    expect(content).toContain('закрыт без «закрывай?»')
    expect(content).toContain('Autopilot сброшен')
    expect(content).toContain('Действие Максима: не требуется')
    expect(content).not.toContain('complete_visible_dispatch')
    expect(content).not.toContain('close_visible_dispatch')
    expect(content).not.toContain('status=')
  })

  it('APPROVED close with closeVisibleDispatch noop still one success RU', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'verdict', text: 'CODE REVIEW: APPROVED' }
    mockFinalizeCloseResult = { ok: true, status: 'closed', text: 'closed bead-plan' }
    mockCloseVisibleResult = { status: 'noop', text: 'no live panes' }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] code-reviewer · задача task-rev завершена taskId=task-rev',
    }, harness.ctx)

    expect(mockCloseVisibleCalls).toEqual([{ beadId: 'bead-plan' }])
    expect(harness.statuses['plan-mode']).toBeUndefined()
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop')
    expect(String(hops[0]?.message.content)).toContain('Панели закрыты или уже не live')
    expect(String(hops[0]?.message.content)).not.toContain('close_visible_dispatch')
  })

  it('close-blocked stopClose clears autopilot, durable STOP CLOSE, no matrix dump', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'verdict', text: 'CODE REVIEW: APPROVED' }
    const longMatrix = 'ACCEPTANCE MATRIX:\n' + 'FAIL row long body marker UNIQUE_MATRIX_BODY_6wwm '.repeat(40)
    mockFinalizeCloseResult = {
      ok: false,
      status: 'blocked',
      text: longMatrix,
      blockingRows: [
        { item: 'criterion A', result: 'FAIL', evidence: 'UNIQUE_MATRIX_BODY_6wwm fail detail' },
        { item: 'criterion B', result: 'NOT RUN', evidence: 'skipped' },
        { item: 'criterion C', result: 'PASS', evidence: 'ok' },
      ],
    }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] code-reviewer · задача task-rev завершена taskId=task-rev',
    }, harness.ctx)

    expect(mockCloseVisibleCalls).toEqual([{ beadId: 'bead-plan', stopClose: true }])
    expect(harness.statuses['plan-mode']).toBeUndefined()
    const stopComments = harness.execCalls.filter((c) => c.command === 'bd' && c.args[0] === 'comments' && c.args[1] === 'add' && String(c.args[3] ?? '').includes('STOP CLOSE:'))
    expect(stopComments).toHaveLength(1)
    const commentBody = String(stopComments[0]?.args[3] ?? '')
    expect(commentBody).toContain('STOP CLOSE:')
    expect(commentBody).toContain('FAIL: criterion A')
    expect(commentBody).toContain('NOT RUN: criterion B')
    expect(commentBody).not.toContain('PASS: criterion C')
    expect(commentBody).not.toContain('UNIQUE_MATRIX_BODY_6wwm')
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop-stop')
    const content = String(hops[0]?.message.content)
    expect(content).toContain('STOP close')
    expect(content).toContain('панели этого bead закрыты')
    expect(content).toContain('HUMAN ACCEPTANCE OVERRIDE')
    expect(content).toContain('dispatch_supervisor')
    expect(content).not.toContain('UNIQUE_MATRIX_BODY_6wwm')
    expect(content).not.toContain('ACCEPTANCE MATRIX')
    expect(content).not.toContain(longMatrix.slice(0, 80))
    expect(content).not.toContain('bead уже closed')
    expect(content).toContain('followup_visible_dispatch не вызывался')
  })

  it('blocked+stopClose throw is separate STOP without bead already closed', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'verdict', text: 'CODE REVIEW: APPROVED' }
    mockFinalizeCloseResult = { ok: false, status: 'blocked', text: 'matrix blocked', blockingRows: [{ item: 'x', result: 'FAIL' }] }
    mockCloseVisibleThrow = new Error('stopClose surface failed')

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] code-reviewer · задача task-rev завершена taskId=task-rev',
    }, harness.ctx)

    expect(mockCloseVisibleCalls).toEqual([{ beadId: 'bead-plan', stopClose: true }])
    expect(harness.statuses['plan-mode']).toBeUndefined()
    const stopComments = harness.execCalls.filter((c) => c.command === 'bd' && c.args[0] === 'comments' && c.args[1] === 'add' && String(c.args[3] ?? '').includes('STOP CLOSE:'))
    expect(stopComments).toHaveLength(0)
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop-stop')
    const content = String(hops[0]?.message.content)
    expect(content).toContain('STOP:')
    expect(content).toContain('stopClose surface failed')
    expect(content).toContain('Autopilot сброшен')
    expect(content).not.toContain('bead уже closed')
    expect(content).not.toContain('HUMAN ACCEPTANCE OVERRIDE')
    expect(content).not.toContain('UNIQUE_MATRIX_BODY_6wwm')
  })

  it('missing-evidence keeps panes and does not stopClose', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'verdict', text: 'CODE REVIEW: APPROVED' }
    mockFinalizeCloseResult = { ok: false, status: 'missing-evidence', text: 'finalizeVisibleReviewClose: missing START_COMMIT' }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] code-reviewer · задача task-rev завершена taskId=task-rev',
    }, harness.ctx)

    expect(mockCloseVisibleCalls).toHaveLength(0)
    expect(harness.statuses['plan-mode']).toBe('autopilot')
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop-stop')
    const content = String(hops[0]?.message.content)
    expect(content).toContain('close path заблокирован')
    expect(content).toContain('панели живы')
  })

  it('closeVisibleDispatch throw clears autopilot and sends one STOP without success trailer', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'verdict', text: 'CODE REVIEW: APPROVED' }
    mockFinalizeCloseResult = { ok: true, status: 'closed', text: 'closed bead-plan' }
    mockCloseVisibleThrow = new Error('cmux close-surface failed')

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] code-reviewer · задача task-rev завершена taskId=task-rev',
    }, harness.ctx)

    expect(mockCloseVisibleCalls).toEqual([{ beadId: 'bead-plan' }])
    expect(harness.statuses['plan-mode']).toBeUndefined()
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop-stop')
    const content = String(hops[0]?.message.content)
    expect(content).toContain('STOP:')
    expect(content).toContain('cmux close-surface failed')
    expect(content).toContain('Autopilot сброшен')
    expect(content).not.toContain('Действие Максима: не требуется')
    expect(content).not.toContain('закрыт без «закрывай?»')
    expect(hopContents(harness).filter((c) => c.includes('STOP:'))).toHaveLength(1)
  })

  it('requestReviewerDispatch throw is one short RU STOP', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'submitted', text: 'Status: DONE' }
    mockReviewerDispatchThrow = new Error('spawn reviewer failed')

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] test-supervisor · задача task-sup завершена taskId=task-sup',
    }, harness.ctx)

    expect(mockReviewerDispatchCalls).toHaveLength(1)
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop-stop')
    const content = String(hops[0]?.message.content)
    expect(content).toContain('STOP:')
    expect(content).toContain('spawn reviewer failed')
    expect(content).not.toContain('complete_visible_dispatch')
  })

  it('NOT APPROVED keeps panes and stops with one ask', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'verdict', text: 'CODE REVIEW: NOT APPROVED' }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] code-reviewer · задача task-rev завершена taskId=task-rev',
    }, harness.ctx)

    expect(mockFinalizeCloseCalls).toHaveLength(0)
    expect(mockCloseVisibleCalls).toHaveLength(0)
    expect(harness.statuses['plan-mode']).toBe('autopilot')
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop-stop')
    expect(String(hops[0]?.message.content)).toContain('NOT APPROVED')
    expect(String(hops[0]?.message.content)).not.toContain('complete_visible_dispatch')
  })

  it('ping without id STOPs and does not complete', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] agent finished without id markers',
    }, harness.ctx)

    expect(mockCompleteVisibleCalls).toHaveLength(0)
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop-stop')
  })

  it('README documents hop UX human message contract', () => {
    const readme = readFileSync(resolve(__dirname, '../../.pi/extensions/plan-mode/README.md'), 'utf8')
    expect(readme).toContain('Hop UX')
    expect(readme).toContain('exactly one')
    expect(readme).toContain('result-only')
    expect(readme).toContain('Жду [PING]')
    expect(readme).toContain('finalize.text')
  })

  it('/plan-auto does not consume ping after approve', async () => {
    const harness = makeHarness()
    await harness.commandHandlers.get('plan-auto')?.handler('', harness.ctx)
    await harness.agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft' }] }] }, harness.ctx)
    await harness.agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: `Reviewer findings summary:\n- ok\nAccepted findings:\n- none\nRejected findings:\n- none\nUnresolved blockers: none\nRevised plan:\n1. Implement\nFiles to change:\n- .pi/extensions/plan-mode/index.ts\nAcceptance:\n- tests\nRisks / rollback:\n- revert\nAUTO_EXECUTE_ALLOWED: true` }] }] }, harness.ctx)

    const result = await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] test-supervisor · задача task-sup завершена taskId=task-sup',
    }, harness.ctx)

    expect(result).toBeUndefined()
    expect(mockCompleteVisibleCalls).toHaveLength(0)
  })
})
