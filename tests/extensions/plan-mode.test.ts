import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

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
        isSafeCommand: () => true,
        markCompletedSteps: (items: unknown[]) => items,
        validateAutoExecutePlan: () => ({ valid: true, reason: '' }),
      }
    }
    if (id === '@earendil-works/pi-agent-core' || id === '@earendil-works/pi-ai' || id === '@earendil-works/pi-coding-agent') return {}
    throw new Error(`Unexpected require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(mockRequire, module, module.exports)
  if (!module.exports.default) throw new Error('plan-mode default export not loaded')
  return module.exports.default
}

function makeHarness() {
  const commandHandlers = new Map<string, { handler: (args: string, ctx: any) => unknown }>()
  const workflowUpdates: unknown[] = []
  const statuses: Record<string, string | undefined> = {}
  const widgets: Record<string, string[] | undefined> = {}
  const activeTools: string[][] = []

  const pi: any = {
    registerFlag() {},
    registerCommand: (name: string, config: { handler: (args: string, ctx: any) => unknown }) => commandHandlers.set(name, config),
    registerShortcut() {},
    on() {},
    appendEntry() {},
    setActiveTools: (tools: string[]) => activeTools.push(tools),
    events: {
      emit: (name: string, event: unknown) => {
        if (name === 'workflow-state:update') workflowUpdates.push(event)
      },
    },
  }
  const ctx: any = {
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

  loadPlanModeExtension()(pi)
  return { commandHandlers, workflowUpdates, statuses, widgets, activeTools, ctx }
}

describe('Pi plan-mode workflow synchronization', () => {
  it('plan-cancel publishes plan=off and clears visible plan status', async () => {
    const { commandHandlers, workflowUpdates, statuses, widgets, activeTools, ctx } = makeHarness()

    await commandHandlers.get('plan')?.handler('', ctx)
    await commandHandlers.get('plan-cancel')?.handler('', ctx)

    expect(workflowUpdates.at(-2)).toMatchObject({ planMode: 'strict', state: 'planning' })
    expect(workflowUpdates.at(-1)).toMatchObject({ planMode: 'off', state: 'idle', stateIfCurrent: ['planning'] })
    expect(statuses['plan-mode']).toBeUndefined()
    expect(widgets['plan-todos']).toBeUndefined()
    expect(activeTools.at(-1)).toEqual(['read', 'bash', 'edit', 'write'])
  })
})
