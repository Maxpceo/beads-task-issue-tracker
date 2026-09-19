import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import * as piTuiMock from '../mocks/pi-tui'

import { findLiveRegistryEntriesForBead } from '../../.pi/extensions/beads-dispatch/index'
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
const expectedPlanTools = ['read', 'bash', 'grep', 'find', 'ls', 'questionnaire', 'plan_mode_complete', 'workflow_status', 'workflow_plan_mode', 'workflow_plan_approved', 'workflow_plan_review', 'plan_subagent']
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
  'spawn_task_workspace',
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
let mockSupervisorDispatchError: string | undefined
let useRealLiveRegistry = false
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

function transpileSibling(relativePath: string): Record<string, unknown> {
  const filePath = resolve(__dirname, '../../.pi/extensions/plan-mode', relativePath.replace(/\.js$/, '.ts'))
  const siblingSource = readFileSync(filePath, 'utf8')
  const { outputText } = ts.transpileModule(siblingSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const siblingModule = { exports: {} as Record<string, unknown> }
  const siblingRequire = (id: string) => {
    if (id === '@earendil-works/pi-tui') return piTuiMock
    throw new Error(`Unexpected sibling require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(siblingRequire, siblingModule, siblingModule.exports)
  return siblingModule.exports
}

function loadPlanModeExtension(): (pi: unknown) => void {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} as { default?: (pi: unknown) => void } }
  const mockRequire = (id: string) => {
    if (id === '@earendil-works/pi-tui') return piTuiMock
    if (id === './question-ui.js') return transpileSibling('question-ui.ts')
    if (id === './ready-ui.js') return transpileSibling('ready-ui.ts')
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
        MAX_PLAN_REVIEW_TOTAL_SPAWNS: 4,
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
          if (mockSupervisorDispatchError) return { ok: false, text: '', error: mockSupervisorDispatchError }
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
        findLiveRegistryEntriesForBead: (beadId: string) => {
          if (useRealLiveRegistry) return findLiveRegistryEntriesForBead(beadId)
          return mockLiveRegistryByBead[beadId] ?? []
        },
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
    if (id === '@earendil-works/pi-agent-core' || id === '@earendil-works/pi-ai') return {}
    if (id === '@earendil-works/pi-coding-agent') return { getMarkdownTheme: () => ({}) }
    throw new Error(`Unexpected require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(mockRequire, module, module.exports)
  if (!module.exports.default) throw new Error('plan-mode default export not loaded')
  return module.exports.default
}

function makeHarness(options: {
  activeStatus?: 'in_progress' | 'inreview'
  registerClaimApiOnDifferentPi?: boolean
  taskScopeGit?: boolean
  commentAddFails?: boolean
  activeBead?: string
  entries?: Array<{ type?: string; customType?: string; data?: unknown }>
  failPreDispatchProgressMessage?: boolean
  /** Throw from pi.sendMessage when message.customType is in this list (f3zr transcript resilience). */
  failSendMessageCustomTypes?: string[]
  /** Throw from pi.appendEntry when customType is in this list. */
  failAppendEntryCustomTypes?: string[]
  initialActiveTools?: string[]
  registeredTools?: string[]
  mode?: 'tui' | 'rpc' | 'json' | 'print'
  /** When set, ui.custom resolves to this value (default: { action: 'execute' } only if factory is ready-ui style). */
  customResult?: unknown
  /** Disable ui.custom entirely (simulate RPC). */
  noCustom?: boolean
  hasUI?: boolean
  readyActionQueue?: Array<'execute' | 'stay' | 'refine' | 'plan-review' | null>
} = {}) {
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
  mockSupervisorDispatchError = undefined
  useRealLiveRegistry = false
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
  const agentSettledHandlers: Array<(event: any, ctx: any) => unknown> = []
  const sessionStartHandlers: Array<(event: any, ctx: any) => unknown> = []
  const beforeAgentStartHandlers: Array<(event?: any, ctx?: any) => unknown> = []
  const sendMessages: Array<{ message: any, options?: any }> = []
  const entryRenderers = new Map<string, (entry: any, options?: any, theme?: any) => any>()
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
      if (event === 'agent_settled') agentSettledHandlers.push(handler)
      if (event === 'session_start') sessionStartHandlers.push(handler)
      if (event === 'before_agent_start') beforeAgentStartHandlers.push(handler)
    },
    registerEntryRenderer: (customType: string, renderer: (entry: any, options?: any, theme?: any) => any) => {
      entryRenderers.set(customType, renderer)
    },
    appendEntry: (customType: string, data: unknown) => {
      if (options.failAppendEntryCustomTypes?.includes(customType)) {
        throw new Error(`appendEntry failed for ${customType}`)
      }
      sessionEntries.push({ type: 'custom', customType, data })
    },
    sendMessage: (message: any, sendOptions?: any) => {
      if (options.failPreDispatchProgressMessage && message.customType === 'post-approval-continuation-started') throw new Error('progress display failed')
      if (options.failSendMessageCustomTypes?.includes(message.customType)) {
        throw new Error(`sendMessage failed for ${message.customType}`)
      }
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
  const customCalls: Array<{ options?: unknown; ranFactory: boolean; factory?: unknown }> = []
  const selectCalls: Array<{ title: string; options: string[] }> = []
  const readyActionQueue = [...(options.readyActionQueue ?? [])]
  const ctx: any = {
    cwd: '/tmp/project',
    mode: options.mode ?? 'tui',
    sessionManager: { getSessionId: () => 'session-current', getEntries: () => sessionEntries },
    hasUI: options.hasUI ?? true,
    ui: {
      notify(text: string, level?: string) {
        trace.push(`notify:${level ?? 'info'}:${text}`)
      },
      select: async (title: string, optionLabels: string[]) => {
        selectCalls.push({ title, options: optionLabels })
        if (readyActionQueue.length > 0) {
          const next = readyActionQueue.shift()
          if (next == null) return undefined
          const labels: Record<string, string> = {
            execute: 'Исполнить',
            stay: 'Остаться в plan mode',
            refine: 'Уточнить',
            'plan-review': 'Отправить на plan-review',
          }
          return labels[next] ?? next
        }
        // Legacy fallback only when tests still hit plain select without complete gate.
        return optionLabels[0]
      },
      input: async () => 'typed-other',
      editor: async () => 'please refine the plan',
      setStatus: (key: string, value: string | undefined) => { statuses[key] = value },
      setWidget: (key: string, value: string[] | undefined) => { widgets[key] = value },
      theme: {
        fg: (_style: string, value: string) => value,
        bg: (_style: string, value: string) => value,
        bold: (value: string) => value,
        strikethrough: (value: string) => value,
      },
      ...(options.noCustom
        ? {}
        : {
            custom: async (factory: (tui: any, theme: any, kb: any, done: (value: any) => void) => any, customOptions?: unknown) => {
              customCalls.push({ options: customOptions, ranFactory: true, factory })
              if (options.customResult !== undefined) return options.customResult
              if (readyActionQueue.length > 0) {
                const next = readyActionQueue.shift()
                return next == null ? null : { action: next }
              }
              // Default: execute only when ready-UI is pending (factory present). Questionnaire tests override customResult.
              return { action: 'execute' }
            },
          }),
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
  return {
    commandHandlers,
    toolHandlers,
    workflowUpdates,
    statuses,
    widgets,
    activeTools,
    inputHandlers,
    toolCallHandlers,
    agentEndHandlers,
    agentSettledHandlers,
    sessionStartHandlers,
    beforeAgentStartHandlers,
    sendMessages,
    sendUserMessages,
    execCalls,
    delayedClaimEvents,
    trace,
    sessionEntries,
    entryRenderers,
    customCalls,
    selectCalls,
    ctx,
  }
}

const SAMPLE_READY_PLAN = [
  'Plan:',
  '1. Implement durable approval.',
  'Files to change:',
  '- .pi/extensions/plan-mode/index.ts',
  'Acceptance:',
  '- vitest passes',
].join('\n')

async function markPlanReady(toolHandlers: Map<string, any>, ctx: any, plan = SAMPLE_READY_PLAN) {
  const tool = toolHandlers.get('plan_mode_complete')
  if (!tool) throw new Error('plan_mode_complete tool not registered')
  return tool.execute('tc-complete', { plan }, undefined, undefined, ctx)
}

function planReadyDocuments(harness: { sessionEntries: Array<{ customType?: string; data?: unknown }> }) {
  return harness.sessionEntries.filter((entry) => entry.customType === 'plan-ready-document') as Array<{ data?: { content?: string } }>
}

function expectExecuteReadyOverlay(customCalls: Array<{ options?: unknown }>) {
  expect(customCalls.length).toBeGreaterThanOrEqual(1)
  for (const call of customCalls) {
    expect(call.options).toMatchObject({ overlay: true })
  }
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
    for (const mutatingWorkflowTool of ['dispatch_supervisor', 'dispatch_reviewer', 'dispatch_docs_agent', 'review_bead', 'workflow_submit_for_review', 'workflow_complete', 'spawn_task_workspace', ...hopWorkflowTools]) {
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
    expect(source).toEqual(expect.stringContaining('extraCycle'))
    expect(source).toEqual(expect.stringContaining('MAX_PLAN_REVIEW_TOTAL_SPAWNS'))
    expect(source).toEqual(expect.stringContaining('Accepted findings'))
    expect(source).toEqual(expect.stringContaining('Rejected findings'))
    // Absolute "MUST NOT call" removed; stop prompt documents extraCycle path instead.
    expect(source).not.toMatch(/MUST NOT call workflow_plan_review again this planning session\. Present the current plan.*do not start a third review cycle/s)
  })

  it('workflow_plan_review caps at 2 spawns: clean APPROVED stops without second spawn; important CONTINUE then STOP; empty no increment; third skips spawn', async () => {
    const { toolHandlers, beforeAgentStartHandlers, sessionEntries, ctx } = makeHarness()

    await toolHandlers.get('workflow_plan_mode')?.execute('call-setup', { mode: 'strict' }, undefined, undefined, ctx)

    const empty = await toolHandlers.get('workflow_plan_review')?.execute('call-empty', { draftPlan: '   ' }, undefined, undefined, ctx)
    expect(empty.details).toMatchObject({ ok: false, error: 'draftPlan is required' })
    expect(mockPlanReviewSpawnCount).toBe(0)

    const mustBefore = await beforeAgentStartHandlers[0]?.({}, ctx) as { message?: { content?: string } }
    expect(mustBefore?.message?.content).toContain('MUST call workflow_plan_review')
    expect(mustBefore?.message?.content).not.toContain('Default auto path stopped')

    const clean = await toolHandlers.get('workflow_plan_review')?.execute('call-clean', {
      draftPlan: 'FAST_PATH_RATIONALE: docs-only\nPlan:\n1. Add one markdown file.\nFiles: docs/note.md',
    }, undefined, undefined, ctx)
    expect(mockPlanReviewSpawnCount).toBe(1)
    expect(clean.details).toMatchObject({ ok: true, cycle: 1, stopAdvice: 'STOP_SHOW_USER', risk: 'low' })
    expect(clean.content[0].text).toContain('STOP_SHOW_USER')
    expect(clean.content[0].text).toContain('extraCycle: true')
    expect(clean.content[0].text).not.toContain('MUST NOT call workflow_plan_review again this planning session')

    const mustNotAfterClean = await beforeAgentStartHandlers[0]?.({}, ctx) as { message?: { content?: string } }
    expect(mustNotAfterClean?.message?.content).toContain('Default auto path stopped')
    expect(mustNotAfterClean?.message?.content).toContain('extraCycle: true')
    expect(mustNotAfterClean?.message?.content).not.toMatch(/you MUST call workflow_plan_review/i)
    expect(mustNotAfterClean?.message?.content).not.toContain('do not start a third review cycle')

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
    expect(mustContinue?.message?.content).not.toContain('Default auto path stopped')

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
    expect(skipThird.content[0].text).toContain('extraCycle: true')

    const mustNotAfterCap = await harness2.beforeAgentStartHandlers[0]?.({}, harness2.ctx) as { message?: { content?: string } }
    expect(mustNotAfterCap?.message?.content).toContain('Default auto path stopped')
    expect(mustNotAfterCap?.message?.content).toContain('extraCycle: true')
    expect(mustNotAfterCap?.message?.content).not.toMatch(/you MUST call workflow_plan_review/i)
    expect(mustNotAfterCap?.message?.content).not.toContain('do not start a third review cycle')

    // Persist cycle fields on appendEntry
    const persisted = sessionEntries.filter((entry) => entry.customType === 'plan-mode').at(-1)
    expect(persisted?.data).toMatchObject({ planReviewCycleCount: 1, lastPlanReviewStopAdvice: 'STOP_SHOW_USER' })
  })

  it('workflow_plan_review extraCycle spawns 3–4 orch; 5th without maxim skips; maxim spawns 5+ STOP; empty+maxim no count', async () => {
    const { toolHandlers, beforeAgentStartHandlers, ctx } = makeHarness()

    await toolHandlers.get('workflow_plan_mode')?.execute('call-setup', { mode: 'strict' }, undefined, undefined, ctx)
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

    const c1 = await toolHandlers.get('workflow_plan_review')?.execute('extra-1', {
      draftPlan: 'Plan:\n1. High-risk policy change.\nFiles: .pi/extensions/plan-mode/index.ts',
    }, undefined, undefined, ctx)
    expect(c1.details).toMatchObject({ ok: true, cycle: 1, stopAdvice: 'CONTINUE' })
    expect(mockPlanReviewSpawnCount).toBe(1)

    const c2 = await toolHandlers.get('workflow_plan_review')?.execute('extra-2', {
      draftPlan: 'Plan:\n1. Revised high-risk policy.\nFiles: .pi/extensions/plan-mode/index.ts',
    }, undefined, undefined, ctx)
    expect(c2.details).toMatchObject({ ok: true, cycle: 2, stopAdvice: 'STOP_SHOW_USER' })
    expect(mockPlanReviewSpawnCount).toBe(2)

    // Without extraCycle: skip + cache
    const skip = await toolHandlers.get('workflow_plan_review')?.execute('extra-skip', {
      draftPlan: 'Plan:\n1. Still revised.\nFiles: .pi/extensions/plan-mode/index.ts',
    }, undefined, undefined, ctx)
    expect(skip.details).toMatchObject({ cycle: 2, skippedSpawn: true, stopAdvice: 'STOP_SHOW_USER' })
    expect(mockPlanReviewSpawnCount).toBe(2)

    // extraCycle true (default requestedBy=orchestrator) → cycle 3 spawn; never CONTINUE
    const c3 = await toolHandlers.get('workflow_plan_review')?.execute('extra-3', {
      draftPlan: 'Plan:\n1. Third-pass revised plan.\nFiles: .pi/extensions/plan-mode/index.ts',
      extraCycle: true,
    }, undefined, undefined, ctx)
    expect(c3.details).toMatchObject({
      ok: true,
      cycle: 3,
      stopAdvice: 'STOP_SHOW_USER',
      extraCycle: true,
      requestedBy: 'orchestrator',
    })
    expect(c3.details.skippedSpawn).toBeUndefined()
    expect(mockPlanReviewSpawnCount).toBe(3)
    expect(c3.content[0].text).toContain('3/4')
    expect(c3.content[0].text).toContain('(extra)')
    expect(c3.content[0].text).not.toContain('CONTINUE')

    const promptAfter3 = await beforeAgentStartHandlers[0]?.({}, ctx) as { message?: { content?: string } }
    expect(promptAfter3?.message?.content).toContain('extraCycle: true')
    expect(promptAfter3?.message?.content).not.toContain('do not start a third review cycle')

    // orch extra below ceiling still works for cycle 4
    const c4 = await toolHandlers.get('workflow_plan_review')?.execute('extra-4', {
      draftPlan: 'Plan:\n1. Fourth-pass revised plan.\nFiles: .pi/extensions/plan-mode/index.ts',
      extraCycle: true,
    }, undefined, undefined, ctx)
    expect(c4.details).toMatchObject({
      ok: true,
      cycle: 4,
      stopAdvice: 'STOP_SHOW_USER',
      extraCycle: true,
      requestedBy: 'orchestrator',
    })
    expect(mockPlanReviewSpawnCount).toBe(4)

    // 5th extraCycle without maxim → skip + cache
    const c5Orch = await toolHandlers.get('workflow_plan_review')?.execute('extra-5-orch', {
      draftPlan: 'Plan:\n1. Fifth attempt orch.\nFiles: .pi/extensions/plan-mode/index.ts',
      extraCycle: true,
    }, undefined, undefined, ctx)
    expect(c5Orch.details).toMatchObject({
      cycle: 4,
      stopAdvice: 'STOP_SHOW_USER',
      skippedSpawn: true,
      extraCycle: true,
      requestedBy: 'orchestrator',
    })
    expect(mockPlanReviewSpawnCount).toBe(4)
    expect(c5Orch.content[0].text).toContain('orchestrator extra')
    expect(c5Orch.content[0].text).toContain('requestedBy: "maxim"')
    expect(c5Orch.content[0].text).not.toContain('even with extraCycle')

    const promptAfterTotal = await beforeAgentStartHandlers[0]?.({}, ctx) as { message?: { content?: string } }
    expect(promptAfterTotal?.message?.content).toContain('requestedBy: "maxim"')
    expect(promptAfterTotal?.message?.content).toContain('Orchestrator extra is forbidden')
    expect(promptAfterTotal?.message?.content).not.toContain('even with extraCycle')
    expect(promptAfterTotal?.message?.content).not.toMatch(/even extraCycle is skipped/i)

    // 5th maxim → spawn cycle 5 STOP, label without /4 denominator
    const c5Maxim = await toolHandlers.get('workflow_plan_review')?.execute('extra-5-maxim', {
      draftPlan: 'Plan:\n1. Fifth attempt maxim.\nFiles: .pi/extensions/plan-mode/index.ts',
      extraCycle: true,
      requestedBy: 'maxim',
    }, undefined, undefined, ctx)
    expect(c5Maxim.details).toMatchObject({
      ok: true,
      cycle: 5,
      stopAdvice: 'STOP_SHOW_USER',
      extraCycle: true,
      requestedBy: 'maxim',
    })
    expect(c5Maxim.details.skippedSpawn).toBeUndefined()
    expect(mockPlanReviewSpawnCount).toBe(5)
    expect(c5Maxim.content[0].text).toContain('5 (extra, maxim)')
    expect(c5Maxim.content[0].text).not.toContain('5/4')
    expect(c5Maxim.content[0].text).not.toContain('CONTINUE')
    expect(c5Maxim.content[0].text).toContain('requestedBy: "maxim"')
    expect(c5Maxim.content[0].text).not.toContain('even with extraCycle')

    const promptAfter5 = await beforeAgentStartHandlers[0]?.({}, ctx) as { message?: { content?: string } }
    expect(promptAfter5?.message?.content).toContain('requestedBy: "maxim"')
    expect(promptAfter5?.message?.content).not.toContain('even with extraCycle')

    // 6th maxim → spawn again
    const c6Maxim = await toolHandlers.get('workflow_plan_review')?.execute('extra-6-maxim', {
      draftPlan: 'Plan:\n1. Sixth attempt maxim.\nFiles: .pi/extensions/plan-mode/index.ts',
      extraCycle: true,
      requestedBy: 'maxim',
    }, undefined, undefined, ctx)
    expect(c6Maxim.details).toMatchObject({
      ok: true,
      cycle: 6,
      stopAdvice: 'STOP_SHOW_USER',
      extraCycle: true,
      requestedBy: 'maxim',
    })
    expect(mockPlanReviewSpawnCount).toBe(6)
    expect(c6Maxim.content[0].text).toContain('6 (extra, maxim)')

    // empty + maxim does not increment
    const emptyMaxim = await toolHandlers.get('workflow_plan_review')?.execute('extra-empty-maxim', {
      draftPlan: '  ',
      extraCycle: true,
      requestedBy: 'maxim',
    }, undefined, undefined, ctx)
    expect(emptyMaxim.details).toMatchObject({ ok: false, error: 'draftPlan is required' })
    expect(mockPlanReviewSpawnCount).toBe(6)

    // extraCycle + empty draft does not increment (orch path)
    const emptyExtra = await toolHandlers.get('workflow_plan_review')?.execute('extra-empty', {
      draftPlan: '  ',
      extraCycle: true,
    }, undefined, undefined, ctx)
    expect(emptyExtra.details).toMatchObject({ ok: false, error: 'draftPlan is required' })
    expect(mockPlanReviewSpawnCount).toBe(6)

    // restore at 2 + extra → spawn 3
    const restored2 = makeHarness({
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
    await restored2.sessionStartHandlers[0]?.({}, restored2.ctx)
    mockPlanReviewSpawnCount = 0
    const afterRestoreExtra = await restored2.toolHandlers.get('workflow_plan_review')?.execute('restored-extra', {
      draftPlan: 'Plan:\n1. After restore extra.',
      extraCycle: true,
    }, undefined, undefined, restored2.ctx)
    expect(afterRestoreExtra.details).toMatchObject({
      cycle: 3,
      stopAdvice: 'STOP_SHOW_USER',
      extraCycle: true,
      requestedBy: 'orchestrator',
    })
    expect(mockPlanReviewSpawnCount).toBe(1)

    // restore at 4 + orch extra → skip
    const restored4 = makeHarness({
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
            planReviewCycleCount: 4,
            lastPlanReviewStopAdvice: 'STOP_SHOW_USER',
            lastPlanReviewResults: defaultMockPlanReviewResults(),
          },
        },
      ],
    })
    await restored4.sessionStartHandlers[0]?.({}, restored4.ctx)
    mockPlanReviewSpawnCount = 0
    const afterRestoreSkip = await restored4.toolHandlers.get('workflow_plan_review')?.execute('restored-total', {
      draftPlan: 'Plan:\n1. After restore total.',
      extraCycle: true,
    }, undefined, undefined, restored4.ctx)
    expect(afterRestoreSkip.details).toMatchObject({
      cycle: 4,
      skippedSpawn: true,
      stopAdvice: 'STOP_SHOW_USER',
      requestedBy: 'orchestrator',
    })
    expect(mockPlanReviewSpawnCount).toBe(0)

    // restore at 4 + maxim → spawn 5
    const afterRestoreMaxim = await restored4.toolHandlers.get('workflow_plan_review')?.execute('restored-maxim', {
      draftPlan: 'Plan:\n1. After restore maxim.',
      extraCycle: true,
      requestedBy: 'maxim',
    }, undefined, undefined, restored4.ctx)
    expect(afterRestoreMaxim.details).toMatchObject({
      cycle: 5,
      stopAdvice: 'STOP_SHOW_USER',
      extraCycle: true,
      requestedBy: 'maxim',
    })
    expect(afterRestoreMaxim.details.skippedSpawn).toBeUndefined()
    expect(mockPlanReviewSpawnCount).toBe(1)
    expect(afterRestoreMaxim.content[0].text).toContain('5 (extra, maxim)')
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
    expect(blocked.content[0].text).toContain('no readable task worktree')
    expect(blocked.content[0].text).toContain('bd worktree create')
    expect(blocked.content[0].text).toContain('--branch task/plan-approved')
    expect(blocked.content[0].text).not.toContain('refusing to approve against ambiguous main-start cwd')
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
    expect(blocked.content[0].text).toContain('no readable task worktree')
    expect(blocked.content[0].text).toContain('bd worktree create')
    expect(blocked.content[0].text).not.toContain('--branch main')
    expect(blocked.content[0].text).not.toContain('<path>')
    expect(blocked.content[0].text).not.toContain('<canonical-task-branch>')
    expect(blocked.content[0].text).not.toMatch(/PLAN APPROVED/)
    expect(blocked.content[0].text).not.toContain('runtime hook missing')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
    expect(mockSupervisorDispatchCalls).toHaveLength(0)
    expect(sendMessages).toHaveLength(0)
  })

  it('workflow_plan_approved uses plan-evidence canon in recovery when recorded scope is protected main', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({
      entries: [{ type: 'workflow-state', data: { activeBead: 'bead-plan', branch: 'main', worktreePath: '/tmp/project', sessionKey: 'id:session-current' } }],
    })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-recorded-main-with-evidence-canon', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: recover with executable canon from evidence.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: recovery names the future task worktree.',
        'BRANCH: fix/llvr-plan-approve-main-worktree-deadlock',
        'WORKTREE: /tmp/llvr-plan-approve-main-worktree-deadlock',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toMatch(/no readable task worktree|not a readable git worktree/)
    expect(blocked.content[0].text).toContain('bd worktree create /tmp/llvr-plan-approve-main-worktree-deadlock --branch fix/llvr-plan-approve-main-worktree-deadlock')
    expect(blocked.content[0].text).not.toContain('--branch main')
    expect(blocked.content[0].text).not.toContain('<path>')
    expect(blocked.content[0].text).not.toContain('<canonical-task-branch>')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
  })

  it('workflow_plan_approved recovers incomplete recorded scope with no readable task worktree + recovery', async () => {
    const { toolHandlers, workflowUpdates, execCalls, ctx } = makeHarness({
      taskScopeGit: true,
      entries: [{ type: 'workflow-state', data: { activeBead: 'bead-plan', branch: 'task/plan-approved', sessionKey: 'id:session-current' } }],
    })

    const blocked = await toolHandlers.get('workflow_plan_approved')?.execute('call-recorded-incomplete-recoverable', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: incomplete recorded scope is recoverable.',
        'Files: .pi/extensions/plan-mode/index.ts.',
        'Acceptance: recovery is executable.',
        'BRANCH: task/plan-approved',
        'WORKTREE: /tmp/missing-incomplete',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(blocked.content[0].text).toContain('workflow_plan_approved blocked')
    expect(blocked.content[0].text).toContain('bd worktree create /tmp/missing-incomplete --branch task/plan-approved')
    expect(blocked.content[0].text).not.toContain('no worktreePath; refusing')
    expect(execCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'bd', args: expect.arrayContaining(['comments', 'add', 'bead-plan']) }),
    ]))
    expect(workflowUpdates).toHaveLength(0)
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

  it('workflow_plan_approved with nonempty FAST_PATH_RATIONALE skips supervisor dispatch (triggerTurn false)', async () => {
    const { toolHandlers, sendMessages, workflowUpdates, execCalls, ctx } = makeHarness({ taskScopeGit: true })

    const approved = await toolHandlers.get('workflow_plan_approved')?.execute('call-fast-path-skip', {
      beadId: 'bead-plan',
      planEvidence: [
        'FAST_PATH_RATIONALE: single-file docs tweak cheaper than supervisor',
        'Plan: edit one skill sentence.',
        'Files to change:',
        '- .pi/skills/plan-bead/SKILL.md',
        'Acceptance: Fast Path skip after approve',
        'Branch: task/plan-approved',
        'Worktree: /tmp/task',
        'START_COMMIT: task123',
      ].join('\n'),
    }, undefined, undefined, ctx)

    const comment = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')?.args[3] ?? ''
    expect(comment).toContain('PLAN APPROVED')
    expect(comment).toContain('FAST_PATH_RATIONALE: single-file docs tweak cheaper than supervisor')
    expect(approved.content[0].text).toContain('workflow_plan_approved recorded')
    expect(approved.content[0].text).toContain('fastPathSkip')
    expect(approved.content[0].text).not.toContain('continuation attempted')
    expect(approved.details).toMatchObject({ ok: true, fastPathSkip: true, continuationSkipReason: 'fastPath' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'implementing', planApproved: true })
    expect(mockSupervisorDispatchCalls).toHaveLength(0)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation-started')).toBe(false)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation')).toBe(false)
    const skipMessage = sendMessages.find((message) => message.message.customType === 'post-approval-fast-path-skip')
    expect(skipMessage?.message.content).toContain('do not dispatch_supervisor')
    expect(skipMessage?.message.content).toContain('do not wait for ping')
    expect(skipMessage?.options).toMatchObject({ triggerTurn: false })
  })

  it('workflow_plan_approved without FAST_PATH_RATIONALE still dispatches supervisor', async () => {
    const { toolHandlers, sendMessages, ctx } = makeHarness({ taskScopeGit: true })

    const approved = await toolHandlers.get('workflow_plan_approved')?.execute('call-non-fast-path', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: implement supervisor path.',
        'Files to change:',
        '- .pi/extensions/plan-mode/index.ts',
        'Acceptance: dispatch still runs',
        'Branch: task/plan-approved',
        'Worktree: /tmp/task',
        'START_COMMIT: task123',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(approved.content[0].text).toContain('continuation attempted')
    expect(approved.content[0].text).not.toContain('fastPathSkip')
    expect(approved.details).toMatchObject({ ok: true, fastPathSkip: false })
    expect(approved.details.continuationSkipReason).toBeUndefined()
    expect(mockSupervisorDispatchCalls).toHaveLength(1)
    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-plan', cwd: '/tmp/task', transport: 'cmux' })
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation-started')).toBe(true)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-fast-path-skip')).toBe(false)
  })

  it('empty FAST_PATH_RATIONALE with next line Plan: still dispatches', async () => {
    const { toolHandlers, sendMessages, ctx } = makeHarness({ taskScopeGit: true })

    await toolHandlers.get('workflow_plan_approved')?.execute('call-empty-fast-path', {
      beadId: 'bead-plan',
      planEvidence: [
        'FAST_PATH_RATIONALE:',
        'Plan: empty marker must not skip.',
        'Files to change:',
        '- .pi/extensions/plan-mode/index.ts',
        'Acceptance: dispatch runs',
        'Branch: task/plan-approved',
        'Worktree: /tmp/task',
        'START_COMMIT: task123',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(mockSupervisorDispatchCalls).toHaveLength(1)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-fast-path-skip')).toBe(false)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation-started')).toBe(true)
  })

  it('prose FAST_PATH_RATIONALE without field line still dispatches', async () => {
    const { toolHandlers, sendMessages, ctx } = makeHarness({ taskScopeGit: true })

    await toolHandlers.get('workflow_plan_approved')?.execute('call-prose-fast-path', {
      beadId: 'bead-plan',
      planEvidence: [
        'Plan: mention FAST_PATH_RATIONALE in prose without a field line.',
        'Files to change:',
        '- .pi/extensions/plan-mode/index.ts',
        'Acceptance: dispatch runs',
        'Branch: task/plan-approved',
        'Worktree: /tmp/task',
        'START_COMMIT: task123',
      ].join('\n'),
    }, undefined, undefined, ctx)

    expect(mockSupervisorDispatchCalls).toHaveLength(1)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-fast-path-skip')).toBe(false)
  })

  it('UI Execute Fast Path skips spawn and uses triggerTurn true', async () => {
    const { commandHandlers, toolHandlers, agentSettledHandlers, sendMessages, workflowUpdates, execCalls, ctx } = makeHarness({ activeBead: 'bead-ui', taskScopeGit: true })
    const plan = [
      'FAST_PATH_RATIONALE: UI execute should implement without supervisor',
      SAMPLE_READY_PLAN,
      'Branch: task/plan-approved',
      'Worktree: /tmp/task',
      'START_COMMIT: task123',
    ].join('\n')

    await commandHandlers.get('plan')?.handler('', ctx)
    await markPlanReady(toolHandlers, ctx, plan)
    await agentSettledHandlers[0]?.({}, ctx)

    const comment = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')?.args[3] ?? ''
    expect(comment).toContain('PLAN APPROVED')
    expect(comment).toContain('FAST_PATH_RATIONALE:')
    expect(workflowUpdates.at(-1)).toMatchObject({ activeBead: 'bead-ui', sessionMode: 'implementing', planApproved: true })
    expect(mockSupervisorDispatchCalls).toHaveLength(0)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation-started')).toBe(false)
    const skipMessage = sendMessages.find((message) => message.message.customType === 'post-approval-fast-path-skip')
    expect(skipMessage?.message.content).toContain('implement now')
    expect(skipMessage?.message.content).toContain('do not dispatch_supervisor')
    expect(skipMessage?.options).toMatchObject({ triggerTurn: true })
  })

  it('/plan-auto plus nonempty FAST_PATH_RATIONALE skips spawn and uses triggerTurn true', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, workflowUpdates, ctx } = makeHarness()

    await commandHandlers.get('plan-auto')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft gate' }] }] }, ctx)
    await agentEndHandlers[0]?.({
      messages: [{
        role: 'assistant',
        content: [{
          type: 'text',
          text: [
            'Reviewer findings summary:',
            '- reviewers approved',
            'Accepted findings:',
            '- none',
            'Rejected findings:',
            '- none',
            'Unresolved blockers: none',
            'Revised plan:',
            '1. Implement gate',
            'FAST_PATH_RATIONALE: plan-auto Fast Path without supervisor',
            'Files to change:',
            '- .pi/extensions/plan-mode/index.ts',
            'Acceptance:',
            '- tests pass',
            'Risks / rollback:',
            '- revert',
            'AUTO_EXECUTE_ALLOWED: true',
          ].join('\n'),
        }],
      }],
    }, ctx)

    expect(mockSupervisorDispatchCalls).toHaveLength(0)
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'implementing', planApproved: true })
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation')).toBe(false)
    const skipMessage = sendMessages.find((message) => message.message.customType === 'post-approval-fast-path-skip')
    expect(skipMessage?.message.content).toContain('implement now')
    expect(skipMessage?.options).toMatchObject({ triggerTurn: true })
  })

  it('autopilot plus nonempty FAST_PATH_RATIONALE still dispatches supervisor hop', async () => {
    const { commandHandlers, agentEndHandlers, sendMessages, execCalls, statuses, ctx } = makeHarness()

    await commandHandlers.get('plan-autopilot')?.handler('', ctx)
    await agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft gate' }] }] }, ctx)
    await agentEndHandlers[0]?.({
      messages: [{
        role: 'assistant',
        content: [{
          type: 'text',
          text: [
            'Reviewer findings summary:',
            '- reviewers approved',
            'Accepted findings:',
            '- none',
            'Rejected findings:',
            '- none',
            'Unresolved blockers: none',
            'Revised plan:',
            '1. Implement gate',
            'FAST_PATH_RATIONALE: autopilot hop must keep dispatch',
            'Files to change:',
            '- .pi/extensions/plan-mode/index.ts',
            'Acceptance:',
            '- tests pass',
            'Risks / rollback:',
            '- revert',
            'AUTO_EXECUTE_ALLOWED: true',
          ].join('\n'),
        }],
      }],
    }, ctx)

    const comment = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')?.args[3] ?? ''
    expect(comment).toContain('Approved-by: оркестратор')
    expect(comment).toContain('AUTOPILOT: true')
    expect(comment).toContain('FAST_PATH_RATIONALE: autopilot hop must keep dispatch')
    expect(mockSupervisorDispatchCalls).toHaveLength(1)
    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-plan', cwd: '/tmp/task', transport: 'cmux' })
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-fast-path-skip')).toBe(false)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation-started')).toBe(true)
    expect(statuses['plan-mode']).toBe('autopilot')
  })

  it('UI Execute writes durable PLAN APPROVED comment and shows started/running progress before dispatch resolves', async () => {
    const { commandHandlers, toolHandlers, agentSettledHandlers, sendMessages, workflowUpdates, execCalls, trace, statuses, widgets, ctx } = makeHarness({ activeBead: 'bead-ui' })
    let releaseDispatch!: () => void
    mockSupervisorDispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve })

    await commandHandlers.get('plan')?.handler('', ctx)
    const execution = markPlanReady(toolHandlers, ctx) as Promise<unknown>
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
    const { commandHandlers, toolHandlers, agentSettledHandlers, sendMessages, workflowUpdates, execCalls, ctx } = makeHarness({ activeBead: 'bead-ui' })
    mockSupervisorDispatchAvailable = false

    await commandHandlers.get('plan')?.handler('', ctx)
    await markPlanReady(toolHandlers, ctx)
    await agentSettledHandlers[0]?.({}, ctx)

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
    const { commandHandlers, toolHandlers, agentSettledHandlers, sendMessages, ctx } = makeHarness({ activeBead: 'bead-ui' })
    mockSupervisorDispatchSpawned = true

    await commandHandlers.get('plan')?.handler('', ctx)
    await markPlanReady(toolHandlers, ctx)
    await agentSettledHandlers[0]?.({}, ctx)

    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-ui', cwd: '/tmp/task', transport: 'cmux' })
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe('/Users/maksimposudevskiy/Projects/beads-task-issue-tracker')
    expect(sendMessages.at(-1)?.message.content).toContain('supervisor spawned, waiting ping')
    expect(sendMessages.at(-1)?.message.content).not.toContain('PLAN APPROVED continuation completed')
  })

  it('continues dispatch when best-effort pre-dispatch progress message cannot be displayed', async () => {
    const { commandHandlers, toolHandlers, agentSettledHandlers, sendMessages, ctx } = makeHarness({ activeBead: 'bead-ui', failPreDispatchProgressMessage: true })

    await commandHandlers.get('plan')?.handler('', ctx)
    await markPlanReady(toolHandlers, ctx)
    await agentSettledHandlers[0]?.({}, ctx)

    expect(mockSupervisorDispatchCalls.at(-1)).toMatchObject({ beadId: 'bead-ui', cwd: '/tmp/task' })
    expect(mockSupervisorDispatchCalls.at(-1)?.cwd).not.toBe(ctx.cwd)
    expect(sendMessages.some((message) => message.message.customType === 'post-approval-continuation-started')).toBe(false)
    expect(sendMessages.at(-1)?.message.customType).toBe('post-approval-continuation')
    expect(sendMessages.at(-1)?.message.content).toContain('PLAN APPROVED continuation completed')
  })

  it('UI Execute blocks missing explicit worktree before durable comment or planApproved state', async () => {
    const { commandHandlers, toolHandlers, agentSettledHandlers, sendMessages, workflowUpdates, execCalls, ctx } = makeHarness({ activeBead: 'bead-ui', taskScopeGit: true })
    const blockedPlan = [
      'Plan:\n1. Implement durable approval.',
      'Files to change:\n- .pi/extensions/plan-mode/index.ts',
      'Acceptance:\n- vitest passes',
      'BRANCH: task/plan-approved',
      'Worktree / cwd:',
      '- `/tmp/missing`',
    ].join('\n')

    await commandHandlers.get('plan')?.handler('', ctx)
    await markPlanReady(toolHandlers, ctx, blockedPlan)
    await agentSettledHandlers[0]?.({}, ctx)

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
    const { commandHandlers, toolHandlers, agentSettledHandlers, sendMessages, workflowUpdates, execCalls, activeTools, ctx } = makeHarness({ activeBead: 'bead-ui', commentAddFails: true })

    await commandHandlers.get('plan')?.handler('', ctx)
    await markPlanReady(toolHandlers, ctx)
    await agentSettledHandlers[0]?.({}, ctx)

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
      return type === 'autopilot-hop' || type === 'autopilot-hop-stop' || type === 'autopilot-hop-wake-orch'
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
    expect(hops[0]?.message.customType).toBe('autopilot-hop-wake-orch')
    expect(hops[0]?.options?.triggerTurn).toBe(true)
    const content = String(hops[0]?.message.content)
    expect(content).toContain('missing START_COMMIT')
    expect(content).toContain('пинг уже забран')
    expect(content).toContain('НЕ review_bead')
    expect(content).toContain('НЕ complete_visible_dispatch')
    expect(content).toContain('НЕ dispatch_reviewer')
    expect(content).toContain('НЕ hop-retry')
    expect(content).toContain('НЕ fake ping')
    expect(content).toContain('НЕ фабриковать матрицу')
    expect(content).toContain('НЕ bd close из inreview')
    expect(content).toContain('панели живы')
    expect(content).not.toContain('Действие Максима')
    expect(content).not.toContain('close path заблокирован')
  })

  it('APPROVED + finalize not-approved is STOP without wake-orch', async () => {
    const harness = makeHarness()
    await enterAutopilotPlanOff(harness)
    mockCompleteVisibleResult = { status: 'verdict', text: 'CODE REVIEW: APPROVED' }
    mockFinalizeCloseResult = { ok: false, status: 'not-approved', text: 'finalizeVisibleReviewClose: not approved path' }

    await harness.inputHandlers[0]?.({
      source: 'user',
      text: '[PING] code-reviewer · задача task-rev завершена taskId=task-rev',
    }, harness.ctx)

    expect(mockCloseVisibleCalls).toHaveLength(0)
    expect(harness.statuses['plan-mode']).toBe('autopilot')
    const hops = hopMessages(harness)
    expect(hops).toHaveLength(1)
    expect(hops[0]?.message.customType).toBe('autopilot-hop-stop')
    expect(hops[0]?.options?.triggerTurn).not.toBe(true)
    const content = String(hops[0]?.message.content)
    expect(content).toContain('Действие Максима')
    expect(content).toContain('панели живы')
    expect(hops.some((h) => h.message.customType === 'autopilot-hop-wake-orch')).toBe(false)
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

  describe('post-approval continuation idempotent skip',
    () => {
      let tmp: string
      const prevOrch = process.env.ORCH_ROOT
      const prevHome = process.env.HOME

      function seedLiveRegistry(opts: { beadId: string; role: string; hung?: boolean }) {
        const dir = join(process.env.ORCH_ROOT!, 'ns', 'ws-test')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'dispatch-registry.json'), `${JSON.stringify({
          entries: [{
            taskId: `task--${opts.role}`,
            beadId: opts.beadId,
            pane: 'surface:1',
            worktree: '/tmp/task',
            role: opts.role,
            model: 'test',
            taskFile: '/tmp/task.md',
            resultFile: '/tmp/result.md',
            digestFile: '/tmp/digest',
            promptFile: '/tmp/prompt.md',
            status: 'spawned',
            hung: opts.hung,
            createdAt: '2026-09-19T00:00:00.000Z',
          }],
        }, null, 2)}\n`)
      }

      const planEvidence = [
        'Plan: implement supervisor path.',
        'Files to change:',
        '- .pi/extensions/plan-mode/index.ts',
        'Acceptance: dispatch still runs',
        'Branch: task/plan-approved',
        'Worktree: /tmp/task',
        'START_COMMIT: task123',
      ].join('\n')

      beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), '5cb6-plan-mode-'))
        process.env.ORCH_ROOT = tmp
        process.env.HOME = tmp
      })

      afterEach(() => {
        if (prevOrch === undefined) delete process.env.ORCH_ROOT
        else process.env.ORCH_ROOT = prevOrch
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
        rmSync(tmp, { recursive: true, force: true })
      })

      it('live supervisor skips continuation without BLOCKED and keeps implementing',
        async () => {
          const harness = makeHarness({ taskScopeGit: true })
          useRealLiveRegistry = true
          seedLiveRegistry({ beadId: 'bead-plan', role: 'test-supervisor' })

          const approved = await harness.toolHandlers.get('workflow_plan_approved')?.execute('call-already-spawned', {
            beadId: 'bead-plan',
            planEvidence,
          }, undefined, undefined, harness.ctx)

          const comments = harness.execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
          expect(comments).toHaveLength(1)
          expect(comments[0]?.args[3]).toContain('PLAN APPROVED')
          expect(comments[0]?.args[3]).not.toContain('BLOCKED')
          expect(approved.content[0].text).toContain('supervisor already spawned')
          expect(approved.content[0].text).not.toContain('fastPathSkip')
          expect(approved.details).toMatchObject({ ok: true, continuationSkipReason: 'alreadySpawned' })
          expect(approved.details.fastPathSkip).not.toBe(true)
          expect(harness.workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', sessionMode: 'implementing', planApproved: true })
          expect(mockSupervisorDispatchCalls).toHaveLength(0)
          const skipMessage = harness.sendMessages.find((message) => message.message.customType === 'post-approval-continuation-idempotent-skip')
          expect(skipMessage?.message.content).toContain('supervisor already spawned; waiting ping')
          expect(skipMessage?.message.content).toContain('If no ping arrives (dead pane)')
          expect(skipMessage?.message.content).toContain('close_visible_dispatch')
          expect(skipMessage?.options).toMatchObject({ triggerTurn: false })
        })

      it('live implementer failsafe entry skips continuation',
        async () => {
          const harness = makeHarness({ taskScopeGit: true })
          useRealLiveRegistry = true
          seedLiveRegistry({ beadId: 'bead-plan', role: 'implementer' })

          const approved = await harness.toolHandlers.get('workflow_plan_approved')?.execute('call-implementer-skip', {
            beadId: 'bead-plan',
            planEvidence,
          }, undefined, undefined, harness.ctx)

          expect(approved.details).toMatchObject({ continuationSkipReason: 'alreadySpawned' })
          expect(mockSupervisorDispatchCalls).toHaveLength(0)
          expect(harness.sendMessages.some((message) => message.message.customType === 'post-approval-continuation-idempotent-skip')).toBe(true)
        })

      it('live docs-agent entry does not skip supervisor continuation',
        async () => {
          const harness = makeHarness({ taskScopeGit: true })
          useRealLiveRegistry = true
          seedLiveRegistry({ beadId: 'bead-plan', role: 'docs-agent' })

          const approved = await harness.toolHandlers.get('workflow_plan_approved')?.execute('call-docs-no-skip', {
            beadId: 'bead-plan',
            planEvidence,
          }, undefined, undefined, harness.ctx)

          expect(approved.content[0].text).toContain('continuation attempted')
          expect(approved.details.continuationSkipReason).toBeUndefined()
          expect(mockSupervisorDispatchCalls).toHaveLength(1)
          expect(harness.sendMessages.some((message) => message.message.customType === 'post-approval-continuation-idempotent-skip')).toBe(false)
        })

      it('corrupt dispatch-registry.json fail-opens to the dispatch path',
        async () => {
          const harness = makeHarness({ taskScopeGit: true })
          useRealLiveRegistry = true
          const dir = join(process.env.ORCH_ROOT!, 'ns', 'ws-test')
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'dispatch-registry.json'), '{not-json')

          const approved = await harness.toolHandlers.get('workflow_plan_approved')?.execute('call-corrupt-registry', {
            beadId: 'bead-plan',
            planEvidence,
          }, undefined, undefined, harness.ctx)

          expect(approved.content[0].text).toContain('workflow_plan_approved recorded')
          expect(mockSupervisorDispatchCalls).toHaveLength(1)
          expect(harness.sendMessages.some((message) => message.message.customType === 'post-approval-continuation-idempotent-skip')).toBe(false)
        })

      it('dispatch live pane already registered skips instead of scope BLOCKED',
        async () => {
          const harness = makeHarness({ taskScopeGit: true })
          mockSupervisorDispatchError = 'повторный spawn для bead-plan: BLOCKED (live pane already registered; use followup_visible_dispatch({ beadId }))'

          const approved = await harness.toolHandlers.get('workflow_plan_approved')?.execute('call-live-pane-error', {
            beadId: 'bead-plan',
            planEvidence,
          }, undefined, undefined, harness.ctx)

          const comments = harness.execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
          expect(comments).toHaveLength(1)
          expect(comments[0]?.args[3]).toContain('PLAN APPROVED')
          expect(comments.some((call) => String(call.args[3]).includes('BLOCKED: task worktree scope'))).toBe(false)
          expect(approved.details).toMatchObject({ continuationSkipReason: 'alreadySpawned' })
          expect(harness.workflowUpdates.at(-1)).toMatchObject({ sessionMode: 'implementing' })
          expect(mockSupervisorDispatchCalls).toHaveLength(1)
          expect(harness.sendMessages.some((message) => message.message.customType === 'post-approval-continuation-idempotent-skip')).toBe(true)
          expect(harness.sendMessages.some((message) => message.message.customType === 'post-approval-continuation-blocked')).toBe(false)
        })

      it('real continuation scope errors still BLOCKED and state=blocked',
        async () => {
          const harness = makeHarness({ taskScopeGit: true })
          mockSupervisorDispatchError = 'no readable task worktree for continuation'

          await harness.toolHandlers.get('workflow_plan_approved')?.execute('call-scope-regression', {
            beadId: 'bead-plan',
            planEvidence,
          }, undefined, undefined, harness.ctx)

          const comments = harness.execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
          expect(comments[0]?.args[3]).toContain('PLAN APPROVED')
          expect(comments[1]?.args[3]).toContain('BLOCKED: task worktree scope')
          expect(harness.workflowUpdates.at(-1)).toMatchObject({ sessionMode: 'blocked', planApproved: true })
          expect(harness.sendMessages.some((message) => message.message.customType === 'post-approval-continuation-idempotent-skip')).toBe(false)
          expect(harness.sendMessages.at(-1)?.message.customType).toBe('post-approval-continuation-blocked')
        })

      it('autopilot live supervisor skip keeps autopilot flag and implementing',
        async () => {
          const harness = makeHarness()
          useRealLiveRegistry = true
          seedLiveRegistry({ beadId: 'bead-plan', role: 'test-supervisor' })

          await harness.commandHandlers.get('plan-autopilot')?.handler('', harness.ctx)
          await harness.agentEndHandlers[0]?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft gate' }] }] }, harness.ctx)
          await harness.agentEndHandlers[0]?.({
            messages: [{
              role: 'assistant',
              content: [{
                type: 'text',
                text: [
                  'Reviewer findings summary:',
                  '- ok',
                  'Accepted findings:',
                  '- none',
                  'Rejected findings:',
                  '- none',
                  'Unresolved blockers: none',
                  'Revised plan:',
                  '1. Implement',
                  'Files to change:',
                  '- .pi/extensions/plan-mode/index.ts',
                  'Acceptance:',
                  '- tests pass',
                  'Risks / rollback:',
                  '- revert',
                  'AUTO_EXECUTE_ALLOWED: true',
                ].join('\n'),
              }],
            }],
          }, harness.ctx)

          expect(harness.statuses['plan-mode']).toBe('autopilot')
          expect(harness.workflowUpdates.at(-1)).toMatchObject({ sessionMode: 'implementing', planApproved: true })
          expect(mockSupervisorDispatchCalls).toHaveLength(0)
          const comments = harness.execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
          expect(comments.some((call) => String(call.args[3]).includes('BLOCKED'))).toBe(false)
          expect(harness.sendMessages.some((message) => message.message.customType === 'post-approval-continuation-idempotent-skip')).toBe(true)
        })
    })
})

describe('Pi plan-mode complete-when-ready overlay', () => {
  it('strict agent_end does not open ready UI; agent_settled after plan_mode_complete does', async () => {
    const { commandHandlers, agentEndHandlers, agentSettledHandlers, customCalls, selectCalls, execCalls, ctx } = makeHarness({ activeBead: 'bead-ui' })
    await commandHandlers.get('plan')?.handler('', ctx)
    await agentEndHandlers[0]?.({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Clarifying question only' }] }],
    }, ctx)
    expect(customCalls).toHaveLength(0)
    expect(selectCalls).toHaveLength(0)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments')).toBe(false)

    // settled without pending must not open UI either
    await agentSettledHandlers[0]?.({}, ctx)
    expect(customCalls).toHaveLength(0)
  })

  it('plan_mode_complete rejects empty/whitespace plan', async () => {
    const { commandHandlers, toolHandlers, ctx } = makeHarness()
    await commandHandlers.get('plan')?.handler('', ctx)
    const empty = await toolHandlers.get('plan_mode_complete')?.execute('id', { plan: '   ' }, undefined, undefined, ctx)
    expect(empty.content[0].text).toContain('plan must be non-empty')
    expect(empty.details.ok).toBe(false)
  })

  it('plan_mode_complete + ready execute writes PLAN APPROVED via ready UI', async () => {
    const { commandHandlers, toolHandlers, agentSettledHandlers, customCalls, selectCalls, execCalls, workflowUpdates, ctx } = makeHarness({
      activeBead: 'bead-ui',
      readyActionQueue: ['execute'],
    })
    await commandHandlers.get('plan')?.handler('', ctx)
    const complete = await markPlanReady(toolHandlers, ctx)
    expect(complete.details.pending).toBe(false)
    expectExecuteReadyOverlay(customCalls)
    expect(selectCalls.some((call) => call.title.includes('План готов'))).toBe(false)
    const comment = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')?.args[3] ?? ''
    expect(comment).toContain('PLAN APPROVED')
    expect(workflowUpdates.at(-1)).toMatchObject({ planApproved: true, planMode: 'off' })
    const customAfter = customCalls.length
    await agentSettledHandlers[0]?.({}, ctx)
    expect(customCalls.length).toBe(customAfter)
  })

  it('ready-UI exception degrades gracefully: notify + clear pending, no throw, plan mode stays on', async () => {
    const harness = makeHarness({ activeBead: 'bead-ui' })
    await harness.commandHandlers.get('plan')?.handler('', harness.ctx)

    const notifications: Array<{ text: string; level: string }> = []
    harness.ctx.ui.notify = (text: string, level: string) => { notifications.push({ text, level }) }
    harness.ctx.ui.custom = async () => {
      throw new Error('TUI custom exploded')
    }

    const selectBefore = harness.selectCalls.length
    await expect(markPlanReady(harness.toolHandlers, harness.ctx)).resolves.toBeDefined()

    expect(notifications.length).toBeGreaterThanOrEqual(1)
    expect(notifications.some((n) => n.text.includes('plan-mode ready-UI failed') && n.level === 'error')).toBe(true)
    expect(harness.selectCalls.length).toBe(selectBefore)
    const persisted = harness.sessionEntries
      .filter((entry) => entry.customType === 'plan-mode')
      .at(-1) as { data?: { pendingReadyPlan?: string; enabled?: boolean } } | undefined
    expect(persisted?.data?.pendingReadyPlan).toBeUndefined()
    expect(persisted?.data?.enabled).toBe(true)
    expect(harness.execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')).toBe(false)
    expect(harness.workflowUpdates.some((update: any) => update.planApproved === true)).toBe(false)

    await harness.agentSettledHandlers[0]?.({}, harness.ctx)
    expect(harness.selectCalls.length).toBe(selectBefore)
  })

  it('ready stay and Esc clear pending without writing PLAN APPROVED', async () => {
    const readyUi = transpileSibling('ready-ui.ts') as { READY_ACTIONS: Array<{ value: string; description?: string }> }
    const stayItem = readyUi.READY_ACTIONS.find((item) => item.value === 'stay')
    expect(stayItem?.description ?? '').toMatch(/pending/i)
    expect(stayItem?.description ?? '').not.toMatch(/оставить pending|keep pending|pending (plan )?kept|оставить pending plan/i)

    const stayHarness = makeHarness({
      activeBead: 'bead-ui',
      readyActionQueue: ['stay'],
    })
    await stayHarness.commandHandlers.get('plan')?.handler('', stayHarness.ctx)
    await markPlanReady(stayHarness.toolHandlers, stayHarness.ctx)

    const stayPersisted = stayHarness.sessionEntries
      .filter((entry) => entry.customType === 'plan-mode')
      .at(-1) as { data?: { pendingReadyPlan?: string; enabled?: boolean } } | undefined
    expect(stayPersisted?.data?.pendingReadyPlan).toBeUndefined()
    expect(stayPersisted?.data?.enabled).toBe(true)
    expect(stayHarness.execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')).toBe(false)
    expect(stayHarness.workflowUpdates.some((update: any) => update.planApproved === true)).toBe(false)

    expect(stayHarness.customCalls.length).toBeGreaterThanOrEqual(1)
    expect(stayHarness.selectCalls.filter((call) => call.title.includes('План готов'))).toHaveLength(0)
    const customAfterStay = stayHarness.customCalls.length
    await stayHarness.agentSettledHandlers[0]?.({}, stayHarness.ctx)
    expect(stayHarness.customCalls.length).toBe(customAfterStay)

    const escHarness = makeHarness({
      activeBead: 'bead-ui',
      readyActionQueue: [null],
    })
    await escHarness.commandHandlers.get('plan')?.handler('', escHarness.ctx)
    await markPlanReady(escHarness.toolHandlers, escHarness.ctx)

    const escPersisted = escHarness.sessionEntries
      .filter((entry) => entry.customType === 'plan-mode')
      .at(-1) as { data?: { pendingReadyPlan?: string; enabled?: boolean } } | undefined
    expect(escPersisted?.data?.pendingReadyPlan).toBeUndefined()
    expect(escPersisted?.data?.enabled).toBe(true)
    expect(escHarness.execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')).toBe(false)
    expect(escHarness.workflowUpdates.some((update: any) => update.planApproved === true)).toBe(false)
  })

  it('plan-review clean: transcript clean note + plan document + re-show select + execute; cycle unchanged', async () => {
    const harness = makeHarness({
      activeBead: 'bead-ui',
      readyActionQueue: ['plan-review', 'execute'],
    })
    await harness.commandHandlers.get('plan')?.handler('', harness.ctx)
    const beforeCycleEntry = harness.sessionEntries
      .filter((entry) => entry.customType === 'plan-mode')
      .at(-1) as { data?: { planReviewCycleCount?: number } } | undefined
    const cycleBefore = beforeCycleEntry?.data?.planReviewCycleCount ?? 0

    const complete = await markPlanReady(harness.toolHandlers, harness.ctx)

    expect(mockPlanReviewSpawnCount).toBe(1)
    expect(harness.sendMessages.some((message) => message.message.customType === 'plan-review-findings')).toBe(false)
    expect(String(complete.content[0].text)).not.toContain('Strict plan critique complete')
    expect(complete.details.pending).toBe(false)
    expect(complete.details.ok).toBe(true)

    expect(harness.trace.some((entry) => entry.startsWith('notify:') && entry.includes('plan-review: запускаю 3 ревьюеров'))).toBe(true)
    expect(harness.trace.some((entry) => entry.startsWith('notify:') && entry.includes('plan-review: чисто'))).toBe(true)

    const cleanMsg = harness.sendMessages.find((message) => message.message.customType === 'plan-review-clean')
    expect(cleanMsg).toBeTruthy()
    expect(String(cleanMsg?.message.content)).toContain('plan-review: чисто')
    expect(cleanMsg?.message.display).toBe(true)
    expect(cleanMsg?.options).toMatchObject({ triggerTurn: false })

    const planDocs = planReadyDocuments(harness)
    expect(planDocs.length).toBeGreaterThanOrEqual(2) // initial overlay + clean re-show
    expect(String(planDocs[0]?.data?.content)).toContain('Plan:')

    const afterEntries = harness.sessionEntries.filter((entry) => entry.customType === 'plan-mode') as Array<{ data?: { planReviewCycleCount?: number; pendingReadyPlan?: string; enabled?: boolean } }>
    const cycleAfter = afterEntries.at(-1)?.data?.planReviewCycleCount ?? 0
    expect(cycleAfter).toBe(cycleBefore)
    expect(afterEntries.at(-1)?.data?.enabled).toBe(false)

    const comment = harness.execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')?.args[3] ?? ''
    expect(comment).toContain('PLAN APPROVED')
    expect(mockSupervisorDispatchCalls.length).toBeGreaterThanOrEqual(1)
    expect(harness.customCalls.length).toBe(2)
    expectExecuteReadyOverlay(harness.customCalls)
    expect(harness.selectCalls.filter((call) => call.title.includes('План готов')).length).toBe(0)
  })

  it('plan-review dirty: transcript findings triggerTurn false + tool result; pending cleared; one select; cycle unchanged', async () => {
    const harness = makeHarness({
      activeBead: 'bead-ui',
      readyActionQueue: ['plan-review', 'execute'],
    })
    mockPlanReviewImportantFindings = [{
      severity: 'important',
      issue: 'missing delivery path for findings',
      evidence: 'ready-ui loop re-showed select',
      suggestedFix: 'return findings in plan_mode_complete tool result',
    }]
    mockPlanReviewResults = defaultMockPlanReviewResults().map((result, index) => index === 0
      ? { ...result, verdict: 'NEEDS_CHANGES' as const, findings: mockPlanReviewImportantFindings }
      : result)
    mockRenderedPlanReviewResults = 'PLAN REVIEW: NEEDS_CHANGES\n- important: missing delivery path'

    await harness.commandHandlers.get('plan')?.handler('', harness.ctx)
    const beforeCycleEntry = harness.sessionEntries
      .filter((entry) => entry.customType === 'plan-mode')
      .at(-1) as { data?: { planReviewCycleCount?: number } } | undefined
    const cycleBefore = beforeCycleEntry?.data?.planReviewCycleCount ?? 0

    const complete = await markPlanReady(harness.toolHandlers, harness.ctx)

    expect(mockPlanReviewSpawnCount).toBe(1)
    expect(String(complete.content[0].text)).toContain('Strict plan critique complete')
    expect(String(complete.content[0].text)).toContain('call plan_mode_complete')
    expect(String(complete.content[0].text)).toMatch(/NEEDS_CHANGES|missing delivery path/)
    expect(complete.details.ok).toBe(false)
    expect(complete.details.pending).toBe(false)
    expect(complete.details.findings).toBe(true)

    const findingsMsgs = harness.sendMessages.filter((message) => message.message.customType === 'plan-review-findings')
    expect(findingsMsgs).toHaveLength(1)
    expect(findingsMsgs[0]?.message.display).toBe(true)
    expect(findingsMsgs[0]?.options).toMatchObject({ triggerTurn: false })
    expect(String(findingsMsgs[0]?.message.content)).toContain('Strict plan critique complete')
    expect(String(findingsMsgs[0]?.message.content)).toMatch(/NEEDS_CHANGES|missing delivery path/)

    const planDoc = planReadyDocuments(harness).at(-1)
    expect(planDoc).toBeTruthy()
    expect(String(planDoc?.data?.content)).toContain('Plan:')

    expect(harness.customCalls.length).toBe(1)
    expectExecuteReadyOverlay(harness.customCalls)
    expect(harness.selectCalls.filter((call) => call.title.includes('План готов')).length).toBe(0)
    expect(harness.execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')).toBe(false)
    expect(mockSupervisorDispatchCalls).toHaveLength(0)

    const afterEntries = harness.sessionEntries.filter((entry) => entry.customType === 'plan-mode') as Array<{ data?: { planReviewCycleCount?: number; pendingReadyPlan?: string; enabled?: boolean } }>
    expect(afterEntries.at(-1)?.data?.pendingReadyPlan).toBeUndefined()
    expect(afterEntries.at(-1)?.data?.enabled).toBe(true)
    expect(afterEntries.at(-1)?.data?.planReviewCycleCount ?? 0).toBe(cycleBefore)

    expect(harness.trace.some((entry) => entry.startsWith('notify:') && entry.includes('plan-review: запускаю 3 ревьюеров'))).toBe(true)
    expect(harness.trace.some((entry) => entry.startsWith('notify:') && entry.includes('plan-review: findings'))).toBe(true)
  })

  it('plan-review notifies start before spawn; notify failure does not cancel spawn', async () => {
    const harness = makeHarness({
      activeBead: 'bead-ui',
      readyActionQueue: ['plan-review', 'execute'],
    })
    let spawnObserved = 0
    const originalNotify = harness.ctx.ui.notify.bind(harness.ctx.ui)
    harness.ctx.ui.notify = (text: string, level?: string) => {
      harness.trace.push(`notify-order:${mockPlanReviewSpawnCount}:${text}`)
      if (text.includes('запускаю 3 ревьюеров')) {
        throw new Error('notify exploded')
      }
      return originalNotify(text, level)
    }

    await harness.commandHandlers.get('plan')?.handler('', harness.ctx)
    await markPlanReady(harness.toolHandlers, harness.ctx)

    expect(mockPlanReviewSpawnCount).toBe(1)
    const startNotify = harness.trace.find((entry) => entry.includes('запускаю 3 ревьюеров'))
    expect(startNotify).toBeTruthy()
    expect(startNotify).toMatch(/^notify-order:0:/)
    spawnObserved = mockPlanReviewSpawnCount
    expect(spawnObserved).toBe(1)
  })

  it('agent_settled leftover plan-review dirty delivers findings via sendMessage triggerTurn:true', async () => {
    const harness = makeHarness({
      activeBead: 'bead-ui',
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: { activeBead: 'bead-ui', branch: 'task/plan-approved', worktreePath: '/tmp/task', startCommit: 'task123' },
        },
        {
          type: 'custom',
          customType: 'plan-mode',
          data: {
            enabled: true,
            autoExecute: false,
            pendingReadyPlan: SAMPLE_READY_PLAN,
            todos: [],
            executing: false,
          },
        },
      ],
      readyActionQueue: ['plan-review'],
    })
    mockPlanReviewImportantFindings = [{
      severity: 'important',
      issue: 'leftover must wake model',
      evidence: 'agent_settled has no tool result channel',
      suggestedFix: 'sendMessage triggerTurn true',
    }]
    mockPlanReviewResults = defaultMockPlanReviewResults().map((result, index) => index === 0
      ? { ...result, verdict: 'NEEDS_CHANGES' as const, findings: mockPlanReviewImportantFindings }
      : result)
    mockRenderedPlanReviewResults = 'PLAN REVIEW: NEEDS_CHANGES\n- important: leftover must wake model'

    await harness.sessionStartHandlers[0]?.({}, harness.ctx)
    await harness.agentSettledHandlers[0]?.({}, harness.ctx)

    expect(mockPlanReviewSpawnCount).toBe(1)
    expect(harness.selectCalls.filter((call) => call.title.includes('План готов')).length).toBe(1)
    // Leftover has no tool-result channel: exactly one findings message wakes the model.
    const findingsMsgs = harness.sendMessages.filter((message) => message.message.customType === 'plan-review-findings')
    expect(findingsMsgs).toHaveLength(1)
    expect(findingsMsgs[0]?.options?.triggerTurn).toBe(true)
    expect(String(findingsMsgs[0]?.message.content)).toContain('Strict plan critique complete')
    expect(String(findingsMsgs[0]?.message.content)).toContain('call plan_mode_complete')

    const leftoverPlan = planReadyDocuments(harness).at(-1)
    expect(leftoverPlan).toBeTruthy()
    expect(String(leftoverPlan?.data?.content)).toContain('Plan:')

    const persisted = harness.sessionEntries
      .filter((entry) => entry.customType === 'plan-mode')
      .at(-1) as { data?: { pendingReadyPlan?: string; enabled?: boolean } } | undefined
    expect(persisted?.data?.pendingReadyPlan).toBeUndefined()
    expect(persisted?.data?.enabled).toBe(true)
  })

  it('execute-path live factory is overlay buttons only; full plan is the transcript entry', async () => {
    const longPlan = Array.from({ length: 200 }, (_, i) => `UNIQUE_PLAN_LINE_${String(i).padStart(3, '0')}`).join('\n')
    const harness = makeHarness({
      activeBead: 'bead-ui',
      readyActionQueue: ['stay'],
    })
    let liveRender = ''
    let liveComp: { render: (width: number) => string[]; handleInput: (data: string) => void } | undefined
    const originalCustom = harness.ctx.ui.custom.bind(harness.ctx.ui)
    harness.ctx.ui.custom = async (factory: any, options?: unknown) => {
      const tui = { requestRender() {} }
      const theme = harness.ctx.ui.theme
      liveComp = factory(tui, theme, {}, () => {})
      liveRender = liveComp!.render(80).join('\n')
      return originalCustom(factory, options)
    }

    await harness.commandHandlers.get('plan')?.handler('', harness.ctx)
    await markPlanReady(harness.toolHandlers, harness.ctx, longPlan)

    expectExecuteReadyOverlay(harness.customCalls)
    expect((harness.customCalls[0]?.options as any)?.overlayOptions).toMatchObject({ anchor: 'bottom-center' })
    expect(harness.selectCalls.filter((call) => call.title.includes('План готов'))).toHaveLength(0)
    expect(liveRender).toContain('Исполнить')
    expect(liveRender).toContain('Отправить на plan-review')
    expect(liveRender).not.toContain('Превью:')
    expect(liveRender).not.toContain('Записать PLAN APPROVED')
    expect(liveRender).not.toContain('UNIQUE_PLAN_LINE_000')
    expect(liveRender).not.toContain('UNIQUE_PLAN_LINE_199')
    expect(liveRender).not.toMatch(/PgUp|PgDn/)
    liveComp!.handleInput(piTuiMock.Key.pageDown)
    expect(liveComp!.render(80).join('\n')).not.toContain('UNIQUE_PLAN_LINE')

    const planDoc = planReadyDocuments(harness).at(-1)
    expect(String(planDoc?.data?.content)).toContain('UNIQUE_PLAN_LINE_000')
    expect(String(planDoc?.data?.content)).toContain('UNIQUE_PLAN_LINE_199')
    expect(harness.sendMessages.some((message) => message.message.customType === 'plan-ready-document')).toBe(false)

    const renderer = harness.entryRenderers.get('plan-ready-document')
    expect(renderer).toBeTypeOf('function')
    const transcript = renderer!({ type: 'custom', customType: 'plan-ready-document', data: { content: longPlan } }, { expanded: false }, harness.ctx.ui.theme)
    expect(transcript).toBeInstanceOf(piTuiMock.Markdown)
    const transcriptText = transcript.render(80).join('\n')
    expect(transcriptText).toContain('UNIQUE_PLAN_LINE_000')
    expect(transcriptText).toContain('UNIQUE_PLAN_LINE_199')
    for (const line of transcript.render(40)) {
      expect(piTuiMock.visibleWidth(line)).toBeLessThanOrEqual(40)
    }

    const chrome = harness.toolHandlers.get('plan_mode_complete')?.renderCall(
      { plan: longPlan },
      harness.ctx.ui.theme,
      {},
    )
    expect(chrome).toBeInstanceOf(piTuiMock.Text)
    const chromeText = chrome.render(80).join('\n')
    expect(chromeText).toContain('plan_mode_complete')
    expect(chromeText).not.toContain('UNIQUE_PLAN_LINE_000')
    expect(chromeText).not.toContain('UNIQUE_PLAN_LINE_199')
    expect(chromeText).not.toContain('UNIQUE_PLAN_LINE')
  })

  it('appendEntry throw for plan-ready-document does not block execute-path overlay ready-UI', async () => {
    const harness = makeHarness({
      activeBead: 'bead-ui',
      readyActionQueue: ['stay'],
      failAppendEntryCustomTypes: ['plan-ready-document'],
    })
    await harness.commandHandlers.get('plan')?.handler('', harness.ctx)
    await expect(markPlanReady(harness.toolHandlers, harness.ctx)).resolves.toBeDefined()
    expectExecuteReadyOverlay(harness.customCalls)
    expect(harness.selectCalls.filter((call) => call.title.includes('План готов'))).toHaveLength(0)
    expect(planReadyDocuments(harness)).toHaveLength(0)
  })

  it('leftover agent_settled ready-UI stays on select, not custom', async () => {
    const { sessionStartHandlers, agentSettledHandlers, customCalls, selectCalls, ctx } = makeHarness({
      activeBead: 'bead-ui',
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: { activeBead: 'bead-ui', branch: 'task/plan-approved', worktreePath: '/tmp/task', startCommit: 'task123' },
        },
        {
          type: 'custom',
          customType: 'plan-mode',
          data: {
            enabled: true,
            autoExecute: false,
            pendingReadyPlan: SAMPLE_READY_PLAN,
            todos: [],
            executing: false,
          },
        },
      ],
      readyActionQueue: ['stay'],
    })

    await sessionStartHandlers[0]?.({}, ctx)
    await agentSettledHandlers[0]?.({}, ctx)
    expect(customCalls).toHaveLength(0)
    expect(selectCalls.some((call) => call.title.includes('План готов'))).toBe(true)
  })

  it('questionnaire sends plan-questionnaire transcript before UI with triggerTurn false', async () => {
    const questions = [
      {
        id: 'scope',
        prompt: 'Какой scope?',
        options: [
          { value: 'narrow', label: 'Узкий' },
          { value: 'wide', label: 'Широкий' },
        ],
      },
    ]
    const harness = makeHarness({
      customResult: {
        questions,
        answers: [{ id: 'scope', value: 'narrow', label: 'Узкий', wasCustom: false, index: 1 }],
        cancelled: false,
      },
    })
    const order: string[] = []
    const originalCustom = harness.ctx.ui.custom.bind(harness.ctx.ui)
    harness.ctx.ui.custom = async (...args: unknown[]) => {
      order.push(`custom:${harness.sendMessages.filter((m) => m.message.customType === 'plan-questionnaire').length}`)
      return originalCustom(...args)
    }

    await harness.commandHandlers.get('plan')?.handler('', harness.ctx)
    const result = await harness.toolHandlers.get('questionnaire')?.execute(
      'q1',
      { questions },
      undefined,
      undefined,
      harness.ctx,
    )

    expect(order.some((entry) => entry.startsWith('custom:') && Number(entry.split(':')[1]) >= 1)).toBe(true)
    const qMsg = harness.sendMessages.find((message) => message.message.customType === 'plan-questionnaire')
    expect(qMsg).toBeTruthy()
    expect(qMsg?.message.display).toBe(true)
    expect(qMsg?.options).toMatchObject({ triggerTurn: false })
    expect(String(qMsg?.message.content)).toContain('Какой scope?')
    expect(String(qMsg?.message.content)).toContain('Узкий')
    expect(String(qMsg?.message.content)).toContain('Широкий')
    expect(result.content[0].text).toContain('Узкий')
  })

  it('sendMessage throw for plan-questionnaire does not block questionnaire UI', async () => {
    const questions = [
      {
        id: 'scope',
        prompt: 'Какой scope?',
        options: [
          { value: 'narrow', label: 'Узкий' },
          { value: 'wide', label: 'Широкий' },
        ],
      },
    ]
    const harness = makeHarness({
      failSendMessageCustomTypes: ['plan-questionnaire'],
      customResult: {
        questions,
        answers: [{ id: 'scope', value: 'narrow', label: 'Узкий', wasCustom: false, index: 1 }],
        cancelled: false,
      },
    })
    await harness.commandHandlers.get('plan')?.handler('', harness.ctx)
    const result = await harness.toolHandlers.get('questionnaire')?.execute(
      'q1',
      { questions },
      undefined,
      undefined,
      harness.ctx,
    )
    expect(result.content[0].text).toContain('Узкий')
    expect(harness.customCalls.length).toBeGreaterThanOrEqual(1)
    expect(harness.sendMessages.some((message) => message.message.customType === 'plan-questionnaire')).toBe(false)
  })

  it('auto/autopilot agent_end clears pending and never opens ready UI', async () => {
    const autoHarness = makeHarness({ activeBead: 'bead-ui' })
    await autoHarness.commandHandlers.get('plan')?.handler('', autoHarness.ctx)
    await markPlanReady(autoHarness.toolHandlers, autoHarness.ctx)
    // Switch to auto clears pending on enter
    await autoHarness.commandHandlers.get('plan-auto')?.handler('', autoHarness.ctx)
    const customBefore = autoHarness.customCalls.length
    await autoHarness.agentEndHandlers[0]?.({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft' }] }],
    }, autoHarness.ctx)
    expect(autoHarness.customCalls.length).toBe(customBefore)
    expect(autoHarness.sendMessages.at(-1)?.message.customType).toBe('plan-review-findings')

    const pilot = makeHarness({ activeBead: 'bead-ui' })
    await pilot.commandHandlers.get('plan-autopilot')?.handler('', pilot.ctx)
    const complete = await markPlanReady(pilot.toolHandlers, pilot.ctx)
    expect(complete.details.pending).toBe(false)
    await pilot.agentEndHandlers[0]?.({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Draft' }] }],
    }, pilot.ctx)
    expect(pilot.customCalls).toHaveLength(0)
  })

  it('restores pendingReadyPlan on session_start and shows ready-UI on next agent_settled', async () => {
    const { sessionStartHandlers, agentSettledHandlers, customCalls, selectCalls, execCalls, ctx } = makeHarness({
      activeBead: 'bead-ui',
      entries: [
        {
          type: 'custom',
          customType: 'workflow-state',
          data: { activeBead: 'bead-ui', branch: 'task/plan-approved', worktreePath: '/tmp/task', startCommit: 'task123' },
        },
        {
          type: 'custom',
          customType: 'plan-mode',
          data: {
            enabled: true,
            autoExecute: false,
            pendingReadyPlan: SAMPLE_READY_PLAN,
            todos: [],
            executing: false,
          },
        },
      ],
      readyActionQueue: ['execute'],
    })

    await sessionStartHandlers[0]?.({}, ctx)
    expect(customCalls).toHaveLength(0)
    expect(selectCalls).toHaveLength(0)
    await agentSettledHandlers[0]?.({}, ctx)
    expect(customCalls).toHaveLength(0)
    expect(selectCalls.some((call) => call.title.includes('План готов'))).toBe(true)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[1] === 'add')).toBe(true)
  })

  it('RPC/no-custom path uses select fallback and never hangs on ui.custom', async () => {
    const { commandHandlers, toolHandlers, agentSettledHandlers, customCalls, selectCalls, execCalls, ctx } = makeHarness({
      activeBead: 'bead-ui',
      mode: 'rpc',
      noCustom: true,
      readyActionQueue: ['execute'],
    })
    await commandHandlers.get('plan')?.handler('', ctx)
    await markPlanReady(toolHandlers, ctx)
    await agentSettledHandlers[0]?.({}, ctx)

    expect(customCalls).toHaveLength(0)
    expect(selectCalls.some((call) => call.title.includes('План готов'))).toBe(true)
    expect(execCalls.some((call) => call.args[1] === 'add')).toBe(true)
  })

  it('questionnaire tool uses custom UI without overlay and supports digit preview path', async () => {
    const questionUi = transpileSibling('question-ui.ts') as any

    const questions = questionUi.normalizeQuestions([
      {
        id: 'scope',
        prompt: 'Какой scope?',
        options: [
          { value: 'narrow', label: 'Узкий', description: 'Только plan-mode' },
          { value: 'wide', label: 'Широкий', description: 'Весь workflow' },
        ],
      },
    ])
    let doneValue: any
    const tui = { requestRender() {} }
    const theme = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    }
    const comp = questionUi.createQuestionUiFactory(questions)(tui, theme, {}, (value: any) => { doneValue = value })
    const rendered = comp.render(80).join('\n')
    expect(rendered).toContain('Какой scope?')
    expect(rendered).toContain('Превью:')
    expect(rendered).toContain('Узкий')
    comp.handleInput('2')
    expect(doneValue?.cancelled).toBe(false)
    expect(doneValue?.answers?.[0]?.value).toBe('wide')

    const readyUi = transpileSibling('ready-ui.ts') as any
    let readyDone: any
    const readyComp = readyUi.createReadyUiFactory()(tui, theme, {}, (value: any) => { readyDone = value })
    const readyRender = readyComp.render(80).join('\n')
    expect(readyRender).toContain('Исполнить')
    expect(readyRender).toContain('Отправить на plan-review')
    expect(readyRender).not.toContain('Превью:')
    expect(readyRender).not.toContain('Записать PLAN APPROVED')
    expect(readyRender).not.toContain('Plan preview line')
    expect(readyRender).not.toMatch(/PgUp|PgDn/)
    readyComp.handleInput('4')
    expect(readyDone).toEqual({ action: 'plan-review' })

    let arrowDone: any
    const arrowComp = readyUi.createReadyUiFactory()(tui, theme, {}, (value: any) => { arrowDone = value })
    arrowComp.handleInput(piTuiMock.Key.down)
    arrowComp.handleInput(piTuiMock.Key.enter)
    expect(arrowDone).toEqual({ action: 'stay' })

    const { commandHandlers, toolHandlers, customCalls, ctx } = makeHarness({
      customResult: {
        questions,
        answers: [{ id: 'scope', value: 'narrow', label: 'Узкий', wasCustom: false, index: 1 }],
        cancelled: false,
      },
    })
    await commandHandlers.get('plan')?.handler('', ctx)
    const result = await toolHandlers.get('questionnaire')?.execute(
      'q1',
      {
        questions: [
          {
            id: 'scope',
            prompt: 'Какой scope?',
            options: [
              { value: 'narrow', label: 'Узкий' },
              { value: 'wide', label: 'Широкий' },
            ],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    )
    expect(result.content[0].text).toContain('Узкий')
    expect(customCalls[0]?.options === undefined || (customCalls[0]?.options as any)?.overlay !== true).toBe(true)
  })

  it('ready-ui and question-ui render never exceed given width', () => {
    const tui = { requestRender() {} }
    const theme = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    }
    const longToken = 'x'.repeat(200)
    const width = 40

    const readyUi = transpileSibling('ready-ui.ts') as any
    const wrapped = readyUi.wrapPlanToWidth(Array.from({ length: 20 }, (_, i) => `W${i}`).join('\n'), 80)
    expect(wrapped[0]).toContain('W0')
    expect(wrapped.join('\n')).toContain('W19')
    const readyComp = readyUi.createReadyUiFactory()(tui, theme, {}, () => {})
    for (const line of readyComp.render(width)) {
      expect(piTuiMock.visibleWidth(line)).toBeLessThanOrEqual(width)
    }
    expect(readyComp.render(80).join('\n')).not.toContain(longToken)
    expect(readyComp.render(80).join('\n')).not.toMatch(/PgUp|PgDn/)

    const manyLines = Array.from({ length: 200 }, (_, i) => `LINE_${i}`).join('\n')
    const transcript = readyUi.renderPlanTranscriptLines(manyLines, 80)
    expect(transcript.join('\n')).toContain('LINE_0')
    expect(transcript.join('\n')).toContain('LINE_199')
    expect(transcript.length).toBeGreaterThan(6)
    for (const line of readyUi.renderPlanTranscriptLines(longToken, width)) {
      expect(piTuiMock.visibleWidth(line)).toBeLessThanOrEqual(width)
    }

    const wrapDumpLines = readyUi.wrapPlanToWidth('word '.repeat(400), 40)
    expect(wrapDumpLines.length).toBeGreaterThan(6)

    const emptyDoc = readyUi.createPlanDocumentComponent('   ', {})
    expect(emptyDoc).toBeInstanceOf(piTuiMock.Text)
    expect(emptyDoc).not.toBeInstanceOf(piTuiMock.Markdown)
    const mdDoc = readyUi.createPlanDocumentComponent(`${longToken}\nUNIQUE_PLAN_LINE_000`, {})
    expect(mdDoc).toBeInstanceOf(piTuiMock.Markdown)
    expect(mdDoc).toBeInstanceOf(readyUi.ClampedMarkdown)
    expect(mdDoc.render(80).join('\n')).toContain('UNIQUE_PLAN_LINE_000')
    for (const line of mdDoc.render(width)) {
      expect(piTuiMock.visibleWidth(line)).toBeLessThanOrEqual(width)
    }

    const questionUi = transpileSibling('question-ui.ts') as any
    const questions = questionUi.normalizeQuestions([
      {
        id: 'overflow',
        prompt: longToken,
        options: [
          { value: 'a', label: longToken, description: longToken },
          { value: 'b', label: 'short' },
        ],
      },
    ])
    const questionComp = questionUi.createQuestionUiFactory(questions)(tui, theme, {}, () => {})
    for (const line of questionComp.render(width)) {
      expect(piTuiMock.visibleWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  it('questionnaire without hasUI cancels without hang', async () => {
    const { commandHandlers, toolHandlers, customCalls, ctx } = makeHarness({ hasUI: false, noCustom: true })
    await commandHandlers.get('plan')?.handler('', ctx)
    const result = await toolHandlers.get('questionnaire')?.execute(
      'q1',
      { questions: [{ id: 'a', prompt: 'Q?', options: [{ value: '1', label: 'One' }] }] },
      undefined,
      undefined,
      ctx,
    )
    expect(result.details.cancelled).toBe(true)
    expect(customCalls).toHaveLength(0)
  })

  it('expected plan tools include plan_mode_complete and JSON schema tools (not Typebox)', async () => {
    const { toolHandlers, commandHandlers, activeTools, ctx } = makeHarness()
    await commandHandlers.get('plan')?.handler('', ctx)
    expect(activeTools.at(-1)).toEqual(expectedPlanTools)
    expect(toolHandlers.has('plan_mode_complete')).toBe(true)
    expect(toolHandlers.has('questionnaire')).toBe(true)
    expect(toolHandlers.get('plan_mode_complete')?.parameters?.type).toBe('object')
    expect(toolHandlers.get('questionnaire')?.parameters?.type).toBe('object')
    // Not Typebox runtime objects
    expect(toolHandlers.get('plan_mode_complete')?.parameters?.[Symbol.for('TypeBox.Kind')]).toBeUndefined()
  })

  it('source no longer contains Plan mode - what next select copy', () => {
    const indexSource = readFileSync(resolve(__dirname, '../../.pi/extensions/plan-mode/index.ts'), 'utf8')
    const readyUiSource = readFileSync(resolve(__dirname, '../../.pi/extensions/plan-mode/ready-ui.ts'), 'utf8')
    expect(indexSource).not.toContain('Plan mode - what next')
    expect(indexSource).toContain('plan_mode_complete')
    expect(indexSource).toMatch(/overlay:\s*true/)
    expect(indexSource).toContain('registerEntryRenderer')
    expect(indexSource).toContain('appendEntry("plan-ready-document"')
    expect(indexSource).toContain('createPlanDocumentComponent')
    expect(indexSource).toContain('getMarkdownTheme')
    expect(indexSource).toContain('renderCall')
    expect(readyUiSource).not.toMatch(/import\s*\{[^}]*SelectList/)
    expect(readyUiSource).not.toMatch(/new SelectList/)
    expect(readyUiSource).toContain('createReadyUiFactory')
    expect(readyUiSource).toContain('createPlanDocumentComponent')
    expect(readyUiSource).toContain('ClampedMarkdown')
    expect(readyUiSource).not.toContain('visiblePlanWindow')
    expect(readyUiSource).not.toMatch(/PgUp|pageUp/)
  })
})

describe('Pi plan-mode display markdown helpers (yxn0)', () => {
  const readyUi = transpileSibling('ready-ui.ts') as {
    planMarkdownTransform: (markdown: string, availableWidth?: number) => string
    wrapPlanMarkdownTheme: (base: unknown) => {
      listBullet: (text: string) => string
      codeBlockBorder: (text: string) => string
    }
    createPlanDocumentComponent: (content: string, mdTheme: unknown) => unknown
    ClampedMarkdown: new (...args: unknown[]) => { render: (width: number) => string[] }
  }
  const readyUiSource = readFileSync(resolve(__dirname, '../../.pi/extensions/plan-mode/ready-ui.ts'), 'utf8')

  it('planMarkdownTransform rewrites column-0 H3+ to ## and leaves H1/H2', () => {
    expect(readyUi.planMarkdownTransform('### A\ntext\n### B')).toBe('## A\ntext\n## B')
    expect(readyUi.planMarkdownTransform('# H1\n## H2\n### H3\n#### H4')).toBe('# H1\n## H2\n## H3\n## H4')
    expect(readyUi.planMarkdownTransform('  ### indented')).toBe('  ### indented')
  })

  it('documents the column-0 ###-inside-fence rewrite limit', () => {
    expect(readyUi.planMarkdownTransform('```\n### inside\n```')).toBe('```\n## inside\n```')
  })

  it('wrapPlanMarkdownTheme rewrites listBullet before the base theme and hides fence backticks', () => {
    const wrapped = readyUi.wrapPlanMarkdownTheme({
      listBullet: (text: string) => `[gold]${text}[/gold]`,
      codeBlockBorder: (text: string) => `[border]${text}[/border]`,
      heading: 'keep',
    })
    expect(wrapped.listBullet('- item')).toBe('[gold]• item[/gold]')
    expect(wrapped.listBullet('* item')).toBe('[gold]• item[/gold]')
    expect(wrapped.listBullet('+ item')).toBe('[gold]• item[/gold]')
    expect(wrapped.codeBlockBorder('```json')).toBe('')
    expect(wrapped.codeBlockBorder('```')).toBe('')
    expect(wrapped.codeBlockBorder('plain')).toBe('[border]plain[/border]')
    expect((wrapped as { heading?: string }).heading).toBe('keep')
  })

  it('wrapPlanMarkdownTheme empty theme still rewrites bullets and blank fence lines', () => {
    const wrapped = readyUi.wrapPlanMarkdownTheme({})
    expect(wrapped.listBullet('- a')).toBe('• a')
    expect(wrapped.codeBlockBorder('```')).toBe('')
    expect(wrapped.codeBlockBorder('x')).toBe('x')
  })

  it('ClampedMarkdown.super passes 5th undefined and 6th transform; createPlan only wraps theme', () => {
    expect(readyUiSource).toContain('export function planMarkdownTransform')
    expect(readyUiSource).toContain('export function wrapPlanMarkdownTheme')
    expect(readyUiSource).toMatch(/super\(\s*text,\s*paddingX,\s*paddingY,\s*mdTheme,\s*undefined,\s*\{\s*transform:\s*planMarkdownTransform\s*\}\s*\)/)
    expect(readyUiSource).toContain('wrapPlanMarkdownTheme(mdTheme)')
    const createPlanSite = readyUiSource.slice(readyUiSource.indexOf('export function createPlanDocumentComponent'))
    expect(createPlanSite).toContain('new ClampedMarkdown(text, 0, 0, theme)')
    expect(createPlanSite).not.toContain('transform: planMarkdownTransform')
  })
})
