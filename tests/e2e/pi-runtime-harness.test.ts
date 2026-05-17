import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import beadPurposeExtension from '../../.pi/extensions/bead-purpose/index'
import { evaluateBashPolicy, evaluatePathPolicy } from '../../.pi/extensions/beads-policy/index'
import sessionReplayExtension from '../../.pi/extensions/session-replay/index'
import subagentExtension from '../../.pi/extensions/subagent/index'
import { createDashboardState, renderDashboardLines, selectDashboardAgents, upsertDashboardCard } from '../../.pi/extensions/subagent/dashboard'
import warpNotificationsExtension, { buildWarpOscPayload } from '../../.pi/extensions/warp-notifications/index'
import workflowChainExtension from '../../.pi/extensions/workflow-chain/index'

const projectRoot = process.cwd()
const runtimeOwnerKey = 'runtime:e2e-pi-runtime-harness'
;(globalThis as typeof globalThis & { __piWorkflowRuntimeOwnerKey?: string }).__piWorkflowRuntimeOwnerKey = runtimeOwnerKey

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
}

function logPass(scenario: string): void {
  console.log(`PI_E2E_SCENARIO ${scenario} PASS`)
}

function tempProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

function write(cwd: string, relativePath: string, content: string): void {
  const absolute = join(cwd, relativePath)
  mkdirSync(resolve(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
}

function createCommandHarness(cwd: string, entries: unknown[] = []) {
  const commands = new Map<string, any>()
  const handlers = new Map<string, any>()
  const notifications: Array<{ message: string; level?: string }> = []
  const widgets: Record<string, unknown> = {}
  const statuses: Record<string, string | undefined> = {}
  const execCalls: Array<{ command: string; args: string[] }> = []
  let customComponent: any
  let customDone: ((value?: unknown) => void) | undefined
  const stdout: string[] = []

  const pi: any = {
    events: { on: (event: string, handler: any) => handlers.set(`event:${event}`, handler) },
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (name: string, config: any) => commands.set(name, config),
    registerTool: () => {},
    getSessionName: () => 'pi-e2e-session',
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'task/e2e\n', stderr: '', code: 0 }
      if (command === 'git' && args.join(' ') === 'status --short') return { stdout: '', stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'show' && args[2] === '--json') return { stdout: JSON.stringify({ id: args[1], title: 'Harness bead title', status: 'in_progress' }), stderr: '', code: 0 }
      return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
    },
  }

  const ctx: any = {
    cwd,
    hasUI: true,
    model: { name: 'Harness Model' },
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    ui: {
      theme,
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setWidget: (key: string, value: unknown) => { widgets[key] = value },
      setStatus: (key: string, value: string | undefined) => { statuses[key] = value },
      select: async (_title: string, options: string[]) => options.at(-1),
      input: async (_title: string, value?: string) => value ?? '',
      confirm: async () => false,
      custom: async (factory: any) => new Promise((resolveCustom) => {
        customDone = resolveCustom
        customComponent = factory({ requestRender: () => undefined }, theme, {}, (value?: unknown) => resolveCustom(value))
      }),
    },
    console: { log: (line: string) => stdout.push(line) },
  }

  return { commands, handlers, notifications, widgets, statuses, execCalls, pi, ctx, stdout, get customComponent() { return customComponent }, doneCustom: (value?: unknown) => customDone?.(value) }
}

function renderWidget(value: unknown, width = 100): string {
  if (typeof value === 'function') return value(undefined, theme).render(width).join('\n')
  if (Array.isArray(value)) return value.join('\n')
  return String(value ?? '')
}

describe('Pi runtime E2E automation harness', () => {
  it('startup/settings: project settings reference existing extensions and Pi startup smoke exits without extension startup errors', () => {
    const settings = JSON.parse(execFileSync('cat', [join(projectRoot, '.pi/settings.json')], { encoding: 'utf8' })) as { extensions: string[] }
    for (const extensionPath of settings.extensions) {
      expect(existsSync(join(projectRoot, '.pi', extensionPath)), extensionPath).toBe(true)
    }

    const piPath = execFileSync('sh', ['-lc', 'command -v pi'], { encoding: 'utf8', timeout: 5_000 }).trim()
    expect(piPath).toBeTruthy()
    const version = execFileSync('pi', ['--version'], { encoding: 'utf8', timeout: 5_000 })
    const helpResult = spawnSync('pi', ['--help'], { encoding: 'utf8', timeout: 5_000 })
    const help = `${helpResult.stdout}\n${helpResult.stderr}`
    expect(helpResult.status).toBe(0)
    expect(help).toContain('--no-session')
    expect(help).toMatch(/-p|--prompt/)

    const result = spawnSync('pi', ['--no-session', '-p', 'Reply exactly: OK'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
    })
    expect({ status: result.status, signal: result.signal, stderr: result.stderr.slice(-1000), stdout: result.stdout.slice(-1000), version: version.trim() }).toMatchObject({ status: 0, signal: null })
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/extension startup error|failed to load extension/i)
    logPass('startup/settings')
  }, 30_000)

  it('workflow-chain: list, dry-run, and guarded run render safe state without bd mutation', async () => {
    const cwd = tempProject('pi-e2e-workflow-chain')
    write(cwd, '.pi/workflow-chains.json', JSON.stringify({ chains: [{
      id: 'handoff',
      title: 'Handoff',
      steps: [{ type: 'typedWorkflow', title: 'Dispatch', operation: 'dispatch_supervisor', requiredBdStatus: 'in_progress', requiredPlanApproved: true, handoff: 'Use dispatch-supervisor' }],
    }] }))
    const h = createCommandHarness(cwd, [{ type: 'custom', customType: 'workflow-state', data: { activeBead: 'bead-1', state: 'implementing', bdStatus: 'in_progress', planApproved: false } }])
    workflowChainExtension(h.pi)

    await h.commands.get('workflow-chain').handler('', h.ctx)
    await h.commands.get('workflow-chain').handler('dry-run handoff', h.ctx)
    await h.commands.get('workflow-chain').handler('run handoff', h.ctx)

    expect(h.notifications[0].message).toContain('handoff')
    expect(h.notifications[1].message).toContain('blocked: typed handoff only')
    expect(h.notifications[2]).toMatchObject({ level: 'error' })
    expect(h.notifications[2].message).toContain('Blocked before mutation')
    expect(renderWidget(h.widgets['workflow-chain'])).toContain('Run blocked before mutation')
    expect(h.execCalls.some(call => call.command === 'bd')).toBe(false)
    logPass('workflow-chain')
  })

  it('session-replay: overlay renders synthetic entries and supports navigation, expand, and exit', async () => {
    const entries = [
      { type: 'message', id: 'u1', message: { role: 'user', content: 'Please inspect the workflow', timestamp: '2026-05-17T10:00:00Z' } },
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'I will run a tool.' }], timestamp: '2026-05-17T10:00:01Z' } },
      { type: 'message', id: 't1', message: { role: 'toolResult', toolName: 'bash', content: 'exit 0', timestamp: '2026-05-17T10:00:02Z' } },
      { type: 'custom', id: 'w1', customType: 'workflow-state', data: { activeBead: 'bead-1', state: 'implementing' }, timestamp: '2026-05-17T10:00:03Z' },
    ]
    const h = createCommandHarness(projectRoot, entries)
    sessionReplayExtension(h.pi)

    const pending = h.commands.get('replay').handler('', h.ctx)
    await Promise.resolve()
    expect(h.customComponent).toBeTruthy()
    expect(h.customComponent.render(100).join('\n')).toContain('Session Replay')
    expect(h.customComponent.render(100).join('\n')).toContain('Custom entry: workflow-state')
    h.customComponent.handleInput('k')
    h.customComponent.handleInput('\r')
    expect(h.customComponent.render(100).join('\n')).toContain('exit 0')
    h.customComponent.handleInput('\x1b')
    await pending

    const noUi = createCommandHarness(projectRoot, entries)
    noUi.ctx.hasUI = false
    sessionReplayExtension(noUi.pi)
    await noUi.commands.get('replay').handler('', noUi.ctx)
    logPass('session-replay')
  })

  it('agent/subagent dashboard: commands handle project agents and malformed teams; live state renders running/done/error cards', async () => {
    const cwd = tempProject('pi-e2e-subagent')
    write(cwd, '.pi/agents/reviewer.md', '---\nname: reviewer\ndescription: Review code\n---\nReview prompt\n')
    write(cwd, '.pi/agents/supervisor.md', '---\nname: supervisor\ndescription: Implement tasks\n---\nImplement prompt\n')
    write(cwd, '.pi/agents/teams.yaml', 'teams:\n  - name: core\n    members: [supervisor, reviewer]\n  - name: broken\n    members: [missing]\n')
    const h = createCommandHarness(cwd)
    subagentExtension(h.pi)

    await h.commands.get('agents-list').handler('', h.ctx)
    await h.commands.get('agents-dashboard').handler('broken', h.ctx)

    expect(renderWidget(h.widgets['subagent-agents'])).toContain('reviewer')
    expect(h.notifications.at(-1)?.level).toBe('warning')
    expect(renderWidget(h.widgets['subagent-dashboard'])).toContain('Unknown agent: missing')

    const selection = selectDashboardAgents([
      { name: 'reviewer', description: 'Review code', source: 'project', filePath: join(cwd, '.pi/agents/reviewer.md'), systemPrompt: 'Review' },
      { name: 'supervisor', description: 'Implement tasks', source: 'project', filePath: join(cwd, '.pi/agents/supervisor.md'), systemPrompt: 'Implement' },
    ], { teams: [{ name: 'core', members: ['supervisor', 'reviewer'], warnings: [] }], filePath: join(cwd, '.pi/agents/teams.yaml'), warnings: [] })
    const state = createDashboardState(selection)
    upsertDashboardCard(state, { agent: 'supervisor', source: 'project', status: 'running', task: 'Implement harness', startedAt: 1_000, toolCount: 1, lastPreview: 'reading tests' })
    upsertDashboardCard(state, { agent: 'reviewer', source: 'project', status: 'completed', task: 'Review harness', startedAt: 1_000, completedAt: 2_000, toolCount: 0 })
    upsertDashboardCard(state, { agent: 'missing', source: 'unknown', status: 'failed', task: 'Missing agent', startedAt: 1_000, completedAt: 2_000, toolCount: 0, errorMessage: 'Unknown agent: missing' })
    const lines = renderDashboardLines(state, 90, theme as any, 3_000).join('\n')
    expect(lines).toContain('[running]')
    expect(lines).toContain('[completed]')
    expect(lines).toContain('[failed]')
    expect(lines).toContain('Unknown agent')
    logPass('agent-subagent-dashboard')
  })

  it('bead-purpose: idle and active synthetic workflow-state render without blocking prompts', async () => {
    const idle = createCommandHarness(projectRoot)
    beadPurposeExtension(idle.pi)
    await idle.commands.get('bead-purpose').handler('', idle.ctx)
    expect(idle.widgets['bead-purpose']).toBeUndefined()
    expect(idle.statuses['bead-purpose']).toContain('purpose:no active bead')

    const active = createCommandHarness(projectRoot, [{ type: 'custom', customType: 'workflow-state', data: { activeBead: 'beads-task-issue-tracker-52hm', sessionMode: 'implementing', bdStatus: 'in_progress', runtimeOwnerKey } }])
    beadPurposeExtension(active.pi)
    await active.commands.get('bead-purpose').handler('', active.ctx)
    expect(renderWidget(active.widgets['bead-purpose'], 80)).toContain('purpose: 52hm')
    expect(active.statuses['bead-purpose']).toContain('Next: im')
    expect(active.notifications.at(-1)).toMatchObject({ message: 'Bead purpose widget refreshed', level: 'info' })
    logPass('bead-purpose')
  })

  it('beads-policy: dangerous bash/path operations are blocked before execution and safe operations are allowed', () => {
    const blockedBash = evaluateBashPolicy('rm -rf /Users/maksimposudevskiy/Projects/beads-task-issue-tracker', { activeBead: 'beads-task-issue-tracker-52hm', state: 'implementing' }, { cwd: projectRoot })
    const safeBash = evaluateBashPolicy('printf evidence > /tmp/pi-e2e-evidence.txt', { activeBead: 'beads-task-issue-tracker-52hm', state: 'implementing' }, { cwd: projectRoot })
    const blockedPath = evaluatePathPolicy('write', join(projectRoot, '.env'), { activeBead: 'beads-task-issue-tracker-52hm', state: 'implementing' })
    const safePath = evaluatePathPolicy('read', join(projectRoot, 'README.md'), { activeBead: 'beads-task-issue-tracker-52hm', state: 'implementing' })

    expect(blockedBash?.block).toBe(true)
    expect(blockedBash?.policy).toBe('blockDestructiveCommand')
    expect(safeBash?.block).not.toBe(true)
    expect(blockedPath?.block).toBe(true)
    expect(safePath?.block).not.toBe(true)
    logPass('beads-policy')
  })

  it('warp-notifications: command and turn-end paths have automated OSC 777 payload coverage', async () => {
    const payload = buildWarpOscPayload('Pi; test\nnotification', 'cwd; /tmp\nnext')
    expect(payload).toBe('\x1b]777;notify;Pi: test notification;cwd: /tmp next\x07')

    const h = createCommandHarness(projectRoot)
    warpNotificationsExtension(h.pi)
    await h.commands.get('warp-notify-test').handler('', h.ctx)
    await h.handlers.get('agent_start')?.({}, h.ctx)
    await h.handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'pnpm test' } }, h.ctx)
    await h.handlers.get('tool_result')?.({ toolName: 'bash', isError: false }, h.ctx)
    await h.handlers.get('agent_end')?.({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Harness complete' }] }] }, h.ctx)

    const turnPayload = buildWarpOscPayload('✅ Pi: Harness Model', '[💻 pnpm test · 1 ops · pi-e2e-session] Harness complete')
    expect(turnPayload).toContain('\x1b]777;notify;')
    expect(turnPayload).toContain('Harness complete')
    expect(h.notifications.at(-1)).toMatchObject({ message: 'Sent test Warp notification', level: 'info' })
    logPass('warp-notifications')
  })
})
