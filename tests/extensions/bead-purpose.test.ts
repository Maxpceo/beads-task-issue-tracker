import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions/bead-purpose/index.ts'), 'utf8')

type Handler = (event: unknown, ctx: MockContext) => Promise<void> | void

interface MockContext {
  hasUI: true
  sessionManager: { getEntries: () => unknown[] }
  ui: {
    theme: { fg: (_color: string, text: string) => string }
    setStatus: (key: string, text: string | undefined) => void
    setWidget: (key: string, factory: WidgetFactory | undefined) => void
    notify: (message: string, level?: string) => void
  }
}

type WidgetFactory = ((tui: unknown, theme: MockContext['ui']['theme']) => { render: (width: number) => string[] }) | undefined

function loadExtension(): (pi: unknown) => void {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} as { default?: (pi: unknown) => void } }
  new Function('module', 'exports', outputText)(module, module.exports)
  if (!module.exports.default) throw new Error('bead-purpose default export not loaded')
  return module.exports.default
}

function createHarness(options: { bdCode?: number; title?: string; exec?: () => Promise<{ stdout: string; stderr: string; code: number }> } = {}) {
  const handlers: Record<string, Handler> = {}
  const theme = { fg: (_color: string, text: string) => text }
  const statuses: Array<[string, string | undefined]> = []
  const widgets: Array<[string, string | undefined]> = []
  const extension = loadExtension()
  const pi = {
    events: { on: (event: string, handler: Handler) => { handlers[`event:${event}`] = handler } },
    on: (event: string, handler: Handler) => { handlers[event] = handler },
    registerCommand() {},
    exec: options.exec ?? (async () => ({
      code: options.bdCode ?? 0,
      stdout: JSON.stringify({ title: options.title ?? 'Resolved bead title' }),
      stderr: '',
    })),
  }
  extension(pi)

  function ctx(data?: unknown): MockContext {
    return {
      hasUI: true,
      sessionManager: { getEntries: () => data ? [{ type: 'custom', customType: 'workflow-state', data }] : [] },
      ui: {
        theme,
        setStatus: (key, text) => statuses.push([key, text]),
        setWidget: (key, factory) => widgets.push([key, factory ? factory(undefined, theme).render(34)[0] : undefined]),
        notify: () => {},
      },
    }
  }

  return { handlers, statuses, widgets, ctx }
}

describe('bead-purpose extension', () => {
  it('keeps idle state unobtrusive and clears the widget', async () => {
    const h = createHarness()

    await h.handlers.session_start?.({}, h.ctx())

    expect(h.widgets).toEqual([['bead-purpose', undefined]])
    expect(h.statuses.at(-1)).toEqual(['bead-purpose', 'purpose:no active bead'])
  })

  it('renders active bead, state, resolved title, and next action without blocking input', async () => {
    const h = createHarness({ title: 'A long active bead title for the purpose widget' })

    await h.handlers.session_start?.({}, h.ctx({ activeBead: 'beads-task-issue-tracker-cqbx', state: 'inreview' }))

    expect(h.statuses.at(-1)?.[1]).toContain('beads-task-issue-tracker-cqbx · inreview')
    expect(h.statuses.at(-1)?.[1]).toContain('Next: review-bead')
    expect(h.widgets.at(-1)?.[1]).toMatch(/^purpose: cqbx · inreview/)
    expect((h.widgets.at(-1)?.[1] ?? '').length).toBeLessThanOrEqual(34)
  })

  it('falls back to bead/state when bd lookup fails', async () => {
    const h = createHarness({ bdCode: 1 })

    await h.handlers.session_start?.({}, h.ctx({ activeBead: 'beads-task-issue-tracker-cqbx', state: 'implementing' }))

    expect(h.statuses.at(-1)?.[1]).toContain('beads-task-issue-tracker-cqbx · implementing')
    expect(h.statuses.at(-1)?.[1]).toContain('title unavailable')
  })

  it('does not restore active widget/status when delayed title lookup resolves after idle refresh', async () => {
    let resolveLookup!: (value: { stdout: string; stderr: string; code: number }) => void
    const h = createHarness({
      exec: () => new Promise(resolve => { resolveLookup = resolve }),
    })
    const activeCtx = h.ctx({ activeBead: 'beads-task-issue-tracker-cqbx', state: 'implementing' })

    const delayedActiveRefresh = h.handlers.session_start?.({}, activeCtx)
    await h.handlers.turn_start?.({}, h.ctx({ state: 'idle' }))
    resolveLookup({ code: 0, stdout: JSON.stringify({ title: 'Stale title' }), stderr: '' })
    await delayedActiveRefresh

    expect(h.widgets).toEqual([['bead-purpose', undefined]])
    expect(h.statuses).toEqual([['bead-purpose', 'purpose:no active bead']])
  })
})
