import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import workflowChainExtension, {
  dryRunRows,
  loadWorkflowChains,
  parseWorkflowChainsYaml,
  typedWorkflowBlockReason,
  type WorkflowChain,
  type WorkflowSnapshot,
} from '../../.pi/extensions/workflow-chain/index'

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'workflow-chain-'))
}

function write(cwd: string, relativePath: string, content: string): void {
  const absolute = join(cwd, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
}

function makeHarness(cwd: string, entries: any[] = [], bdStatus = 'in_progress') {
  const commands = new Map<string, any>()
  const notifications: Array<{ message: string; level?: string }> = []
  const widgets: Record<string, string[] | undefined> = {}
  const statuses: Record<string, string | undefined> = {}
  const execCalls: Array<{ command: string; args: string[] }> = []
  const pi: any = {
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'task/demo\n', stderr: '', code: 0 }
      if (command === 'git' && args.join(' ') === 'status --short') return { stdout: '', stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'show' && args[2] === '--json') return { stdout: JSON.stringify({ id: args[1], status: bdStatus }), stderr: '', code: 0 }
      return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
    },
    registerCommand: (name: string, config: any) => commands.set(name, config),
  }
  const ctx: any = {
    cwd,
    hasUI: true,
    sessionManager: { getEntries: () => entries },
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setWidget: (key: string, value: string[] | undefined) => { widgets[key] = value },
      setStatus: (key: string, value: string | undefined) => { statuses[key] = value },
    },
  }
  workflowChainExtension(pi)
  return { commands, notifications, widgets, statuses, execCalls, ctx }
}

const implementingState: WorkflowSnapshot = { state: 'implementing', activeBead: 'bead-1', branch: 'task/demo' }

describe('workflow-chain config loading', () => {
  it('shows built-in safe chains when project config is missing', () => {
    const result = loadWorkflowChains(tempProject())

    expect(result.source).toBe('built-in')
    expect(result.warnings.join('\n')).toContain('No project workflow-chain config')
    expect(result.chains.map((chain) => chain.id)).toContain('demo-status')
  })

  it('loads only the first config by fixed precedence', () => {
    const cwd = tempProject()
    write(cwd, '.pi/workflow-chains.json', JSON.stringify({ chains: [{ id: 'json-first', title: 'JSON first', steps: [{ type: 'message', message: 'json' }] }] }))
    write(cwd, '.pi/workflow-chains.yaml', 'chains:\n  - id: yaml-second\n    title: YAML second\n    steps:\n      - type: message\n        message: yaml\n')

    const result = loadWorkflowChains(cwd)

    expect(result.source).toBe('.pi/workflow-chains.json')
    expect(result.chains.map((chain) => chain.id)).toContain('json-first')
    expect(result.chains.map((chain) => chain.id)).not.toContain('yaml-second')
  })

  it('reports duplicate IDs in the loaded config as validation errors', () => {
    const cwd = tempProject()
    write(cwd, '.pi/workflow-chains.json', JSON.stringify({ chains: [
      { id: 'dup', title: 'One', steps: [{ type: 'message', message: '1' }] },
      { id: 'dup', title: 'Two', steps: [{ type: 'message', message: '2' }] },
    ] }))

    const result = loadWorkflowChains(cwd)

    expect(result.error).toContain('duplicate chain id dup')
    expect(result.chains.map((chain) => chain.id)).toContain('demo-status')
  })

  it('reports malformed config and unknown step types clearly', () => {
    const malformed = tempProject()
    write(malformed, '.pi/workflow-chains.json', '{ nope')
    expect(loadWorkflowChains(malformed).error).toContain('malformed JSON')

    const unknown = tempProject()
    write(unknown, '.pi/workflow-chains.json', JSON.stringify({ chains: [{ id: 'bad', title: 'Bad', steps: [{ type: 'shell', command: 'bd close x' }] }] }))
    expect(loadWorkflowChains(unknown).error).toContain('unknown step type shell')
  })

  it('parses the documented narrow YAML subset and fails closed on bad indentation', () => {
    const parsed = parseWorkflowChainsYaml('chains:\n  - id: yaml-demo\n    title: YAML Demo\n    description: Demo\n    steps:\n      - type: message\n        message: hello\n      - type: wait\n        ms: 10\n')
    expect(parsed[0]?.id).toBe('yaml-demo')
    expect(parsed[0]?.steps[1]?.ms).toBe(10)

    expect(() => parseWorkflowChainsYaml('chains:\n   - id: bad\n')).toThrow('malformed indentation')
  })

  it('does not scan external agent/config directories', () => {
    const cwd = tempProject()
    write(cwd, '.claude/workflow-chains.json', JSON.stringify({ chains: [{ id: 'claude-chain', title: 'Wrong', steps: [{ type: 'message', message: 'no' }] }] }))
    write(cwd, '.gemini/workflow-chains.json', JSON.stringify({ chains: [{ id: 'gemini-chain', title: 'Wrong', steps: [{ type: 'message', message: 'no' }] }] }))
    write(cwd, '.codex/workflow-chains.json', JSON.stringify({ chains: [{ id: 'codex-chain', title: 'Wrong', steps: [{ type: 'message', message: 'no' }] }] }))

    const result = loadWorkflowChains(cwd)

    expect(result.source).toBe('built-in')
    expect(result.chains.map((chain) => chain.id)).not.toContain('claude-chain')
    expect(result.chains.map((chain) => chain.id)).not.toContain('gemini-chain')
    expect(result.chains.map((chain) => chain.id)).not.toContain('codex-chain')
  })
})

describe('workflow-chain command behavior', () => {
  it('registers /workflow-chain and /chain list commands', async () => {
    const harness = makeHarness(tempProject())

    await harness.commands.get('workflow-chain').handler('', harness.ctx)
    await harness.commands.get('chain').handler('list', harness.ctx)

    expect(harness.notifications[0]?.message).toContain('Workflow chains')
    expect(harness.notifications[0]?.message).toContain('demo-status')
    expect(harness.notifications[1]?.message).toContain('supervisor-handoff')
  })

  it('dry-run shows step guards, typed operation, and mutation policy without bd mutation', async () => {
    const cwd = tempProject()
    write(cwd, '.pi/workflow-chains.json', JSON.stringify({ chains: [{
      id: 'handoff',
      title: 'Handoff',
      steps: [{ type: 'typedWorkflow', title: 'Dispatch', operation: 'dispatch_supervisor', requiredState: 'plan_approved', handoff: 'Use dispatch-supervisor' }],
    }] }))
    const harness = makeHarness(cwd, [{ type: 'custom', customType: 'workflow-state', data: implementingState }])

    await harness.commands.get('workflow-chain').handler('dry-run handoff', harness.ctx)

    expect(harness.notifications[0]?.message).toContain('type=typedWorkflow')
    expect(harness.notifications[0]?.message).toContain('op=dispatch_supervisor')
    expect(harness.notifications[0]?.message).toContain('guard: current implementing not in plan_approved')
    expect(harness.notifications[0]?.message).toContain('blocked: typed handoff only')
    expect(harness.execCalls.some((call) => call.command === 'bd')).toBe(false)
  })

  it('falls back from active bead to bd show status when workflow-state state is missing', async () => {
    const cwd = tempProject()
    write(cwd, '.pi/workflow-chains.json', JSON.stringify({ chains: [{
      id: 'handoff',
      title: 'Handoff',
      steps: [{ type: 'typedWorkflow', title: 'Dispatch', operation: 'dispatch_supervisor', requiredState: 'plan_approved', handoff: 'Use dispatch-supervisor' }],
    }] }))
    const harness = makeHarness(cwd, [{ type: 'custom', customType: 'workflow-state', data: { activeBead: 'bead-1', branch: 'task/demo' } }], 'in_progress')

    await harness.commands.get('workflow-chain').handler('dry-run handoff', harness.ctx)

    expect(harness.execCalls).toContainEqual({ command: 'bd', args: ['show', 'bead-1', '--json'] })
    expect(harness.notifications[0]?.message).toContain('guard: current implementing not in plan_approved')
  })

  it('blocks invalid-state workflow-critical run before mutation with handoff text', async () => {
    const chain: WorkflowChain = { id: 'handoff', title: 'Handoff', steps: [{ type: 'typedWorkflow', operation: 'dispatch_supervisor', requiredState: 'plan_approved', handoff: 'Use dispatch-supervisor' }] }

    expect(typedWorkflowBlockReason(chain, implementingState)).toContain('requires workflow state plan_approved')

    const cwd = tempProject()
    write(cwd, '.pi/workflow-chains.json', JSON.stringify({ chains: [chain] }))
    const harness = makeHarness(cwd, [{ type: 'custom', customType: 'workflow-state', data: implementingState }])

    await harness.commands.get('workflow-chain').handler('run handoff', harness.ctx)

    expect(harness.notifications[0]?.level).toBe('error')
    expect(harness.notifications[0]?.message).toContain('Blocked before mutation')
    expect(harness.notifications[0]?.message).toContain('Use dispatch-supervisor')
    expect(harness.execCalls.some((call) => call.command === 'bd')).toBe(false)
  })

  it('safe demo run reports pending/running/done states and truncates long output', async () => {
    const harness = makeHarness(tempProject(), [{ type: 'custom', customType: 'workflow-state', data: implementingState }])

    await harness.commands.get('workflow-chain').handler('run demo-status', harness.ctx)

    const widgetSnapshots = Object.values(harness.widgets).flat().join('\n')
    expect(widgetSnapshots).toContain('done')
    expect(harness.notifications.at(-1)?.level).toBe('success')
    expect(harness.notifications.at(-1)?.message).toContain('Run demo-status: done')
    expect(harness.notifications.at(-1)?.message).toContain('truncated')
  })

  it('dryRunRows exposes read-only policy for safe steps', () => {
    const chain: WorkflowChain = { id: 'demo', title: 'Demo', steps: [{ type: 'readOnlyBuiltin', operation: 'gitStatus' }] }

    expect(dryRunRows(chain, implementingState)[0]).toContain('safe: no bd mutation')
  })
})
