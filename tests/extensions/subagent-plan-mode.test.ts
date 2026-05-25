import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions/subagent/index.ts'), 'utf8')

function loadSubagentExtension(spawnCalls: Array<{ command: string, args: string[], cwd?: string }>): (pi: unknown) => void {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} as { default?: (pi: unknown) => void } }
  const mockSpawn = (command: string, args: string[], options: { cwd?: string }) => {
    spawnCalls.push({ command, args, cwd: options.cwd })
    const proc: any = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => true
    queueMicrotask(() => {
      proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PLAN FINDINGS: injected context received' }], usage: { input: 1, output: 1, totalTokens: 2 }, model: 'test-model' } }) + '\n')
      proc.stdout.end()
      proc.stderr.end()
      proc.emit('close', 0)
    })
    return proc
  }
  const mockRequire = (id: string) => {
    if (id === 'node:child_process') return { spawn: mockSpawn }
    if (id === 'node:fs') return require('node:fs')
    if (id === 'node:os') return require('node:os')
    if (id === 'node:path') return require('node:path')
    if (id === '@earendil-works/pi-agent-core' || id === '@earendil-works/pi-ai') return { StringEnum: (_values: string[]) => ({}) }
    if (id === '@earendil-works/pi-coding-agent') return { getMarkdownTheme: () => ({}), withFileMutationQueue: async (_file: string, fn: () => Promise<void>) => fn() }
    if (id === '@earendil-works/pi-tui') return { Container: class {}, Markdown: class {}, Spacer: class {}, Text: class { constructor(public text: string) {} } }
    if (id === 'typebox') return { Type: { Object: () => ({}), String: () => ({}), Optional: (v: unknown) => v, Array: () => ({}), Boolean: () => ({}) } }
    if (id === './agents.js') {
      return {
        discoverAgents: (cwd: string) => ({
          projectAgentsDir: `${cwd}/.pi/agents`,
          agents: [
            { name: 'detective', source: 'project', description: 'Detective', systemPrompt: 'Detective prompt', tools: ['read', 'bash', 'edit', 'write'] },
            { name: 'architect', source: 'project', description: 'Architect', systemPrompt: 'Architect prompt', tools: ['read', 'bash', 'edit', 'write'] },
            { name: 'test-supervisor', source: 'project', description: 'Test supervisor', systemPrompt: 'Supervisor prompt', tools: ['read', 'bash', 'edit', 'write'] },
          ],
        }),
        loadProjectAgentTeams: () => ({ teams: [], warnings: [] }),
      }
    }
    if (id === './dashboard.js') {
      return {
        AgentDashboardComponent: class {},
        clearObservedDashboardCards: () => undefined,
        createDashboardState: () => ({ visible: true, cards: new Map() }),
        getSharedDashboardState: () => undefined,
        publishDashboardCard: () => undefined,
        registerDashboardRenderer: () => undefined,
        selectDashboardAgents: () => [],
        setSharedDashboardState: () => undefined,
      }
    }
    throw new Error(`Unexpected require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(mockRequire, module, module.exports)
  if (!module.exports.default) throw new Error('subagent default export not loaded')
  return module.exports.default
}

function makeHarness() {
  const tools = new Map<string, any>()
  const execCalls: Array<{ command: string, args: string[] }> = []
  const spawnCalls: Array<{ command: string, args: string[], cwd?: string }> = []
  const pi: any = {
    registerCommand() {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'bd' && args[0] === 'show') return { stdout: '◐ bead-plan [BUG] Test bead', stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments') return { stdout: 'PLAN APPROVED\nPlan:\n1. Investigate safely.', stderr: '', code: 0 }
      if (command === 'git' && args.includes('branch')) return { stdout: 'fix/plan-safe\n', stderr: '', code: 0 }
      if (command === 'git' && args.includes('HEAD')) return { stdout: 'abc123\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    },
  }
  loadSubagentExtension(spawnCalls)(pi)
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    ui: { setWidget() {}, notify() {}, confirm: async () => true },
    sessionManager: {
      getEntries: () => [{ type: 'custom', customType: 'workflow-state', data: { activeBead: 'bead-plan', branch: 'fix/plan-safe', worktreePath: process.cwd(), startCommit: 'abc123' } }],
    },
  }
  return { tools, execCalls, spawnCalls, ctx }
}

describe('plan_subagent', () => {
  it('launches detective with injected bead/plan context and read-only child tools', async () => {
    const { tools, execCalls, spawnCalls, ctx } = makeHarness()

    const result = await tools.get('plan_subagent').execute('call-1', { agent: 'detective', task: 'Find root cause.', planContext: 'Plan:\n1. Use detective.' }, undefined, undefined, ctx)

    expect(result.details.ok).toBe(true)
    expect(result.details.childTools).toEqual(['read', 'grep', 'find', 'ls'])
    expect(execCalls).toEqual(expect.arrayContaining([
      { command: 'bd', args: ['show', 'bead-plan'] },
      { command: 'bd', args: ['comments', 'bead-plan'] },
    ]))
    const args = spawnCalls[0]!.args
    expect(args).toContain('--tools')
    expect(args[args.indexOf('--tools') + 1]).toBe('read,grep,find,ls')
    expect(args.join('\n')).toContain('BEAD_ID: bead-plan')
    expect(args.join('\n')).toContain('START_COMMIT: abc123')
    expect(args.join('\n')).toContain('PLAN APPROVED')
    expect(args[args.indexOf('--tools') + 1]!.split(',')).not.toEqual(expect.arrayContaining(['bash', 'edit', 'write']))
  })

  it('launches architect through the same plan-safe path', async () => {
    const { tools, spawnCalls, ctx } = makeHarness()

    const result = await tools.get('plan_subagent').execute('call-1', { agent: 'architect', task: 'Review architecture.' }, undefined, undefined, ctx)

    expect(result.details.ok).toBe(true)
    expect(spawnCalls[0]!.args[spawnCalls[0]!.args.indexOf('--tools') + 1]).toBe('read,grep,find,ls')
  })

  it('rejects implementation supervisors before spawn', async () => {
    for (const agent of ['test-supervisor', 'vue-supervisor', 'tauri-supervisor']) {
      const { tools, spawnCalls, ctx } = makeHarness()

      const result = await tools.get('plan_subagent').execute('call-1', { agent, task: 'Implement.' }, undefined, undefined, ctx)

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not allowed')
      expect(spawnCalls).toHaveLength(0)
    }
  })
})
