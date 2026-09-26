import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions-aside-v1dt/subagent/index.ts'), 'utf8')

type Resolved = {
  model?: string
  thinking?: string
  source: 'role' | 'class' | 'inherit'
  thinkingSource: 'role' | 'class' | 'inherit'
  className?: string
}

function loadSubagentExtension(
  spawnCalls: Array<{ command: string, args: string[], cwd?: string }>,
  resolveImpl: () => Resolved,
): (pi: unknown) => void {
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
      proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1, totalTokens: 2 }, model: 'test-model' } }) + '\n')
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
            { name: 'detective', source: 'project', description: 'Detective', systemPrompt: 'Detective prompt', tools: ['read', 'bash'] },
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
        registerDashboardWidgetHost: () => undefined,
        selectDashboardAgents: () => [],
        setSharedDashboardState: () => undefined,
      }
    }
    if (id === '../agent-models/index' || id.endsWith('/agent-models/index') || id.includes('agent-models')) {
      return {
        resolveAgentModelFromCwd: () => resolveImpl(),
        resolveAgentModel: () => resolveImpl(),
        AGENT_MODELS_FILENAME: 'agent-models.json',
      }
    }
    if (id.includes('beads-dispatch/visible-agents') || id.includes('beads-dispatch/cmux-transport')) {
      return {
        resolveVisibleCmuxAdapter: () => ({ identify: async () => ({ workspaceId: 'ws' }) }),
        spawnSyncVisibleAgents: async () => [],
      }
    }
    throw new Error(`Unexpected require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(mockRequire, module, module.exports)
  if (!module.exports.default) throw new Error('subagent default export not loaded')
  return module.exports.default
}

describe('subagent thinking argv', () => {
  it('passes --thinking when resolved (incl. off) and omits on inherit', async () => {
    let resolved: Resolved = {
      model: 'xai/grok-4.5',
      thinking: 'high',
      source: 'class',
      thinkingSource: 'class',
      className: 'standard',
    }
    const spawnCalls: Array<{ command: string, args: string[], cwd?: string }> = []
    const tools = new Map<string, any>()
    const pi: any = {
      on() {},
      registerCommand() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    }
    loadSubagentExtension(spawnCalls, () => resolved)(pi)
    const subagent = tools.get('subagent')
    expect(subagent).toBeDefined()

    await subagent.execute('c1', { agent: 'detective', task: 'hello' }, undefined, undefined, { cwd: process.cwd(), hasUI: false })
    expect(spawnCalls.length).toBeGreaterThan(0)
    const highArgs = spawnCalls[0]!.args
    expect(highArgs).toContain('--model')
    expect(highArgs[highArgs.indexOf('--model') + 1]).toBe('xai/grok-4.5')
    expect(highArgs).toContain('--thinking')
    expect(highArgs[highArgs.indexOf('--thinking') + 1]).toBe('high')

    resolved = {
      model: 'xai/grok-4.5',
      thinking: 'off',
      source: 'class',
      thinkingSource: 'class',
      className: 'standard',
    }
    spawnCalls.length = 0
    await subagent.execute('c2', { agent: 'detective', task: 'hello' }, undefined, undefined, { cwd: process.cwd(), hasUI: false })
    const offArgs = spawnCalls[0]!.args
    expect(offArgs).toContain('--thinking')
    expect(offArgs[offArgs.indexOf('--thinking') + 1]).toBe('off')

    resolved = { source: 'inherit', thinkingSource: 'inherit' }
    spawnCalls.length = 0
    await subagent.execute('c3', { agent: 'detective', task: 'hello' }, undefined, undefined, { cwd: process.cwd(), hasUI: false })
    const inheritArgs = spawnCalls[0]!.args
    expect(inheritArgs).not.toContain('--model')
    expect(inheritArgs).not.toContain('--thinking')
  })
})
