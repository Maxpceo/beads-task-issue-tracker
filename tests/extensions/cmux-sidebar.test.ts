import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions/cmux-sidebar/index.ts'), 'utf8')
const settingsSource = readFileSync(resolve(__dirname, '../../.pi/settings.json'), 'utf8')
const runtimeOwnerKey = 'runtime:test-cmux-sidebar'
;(globalThis as typeof globalThis & { __piWorkflowRuntimeOwnerKey?: string }).__piWorkflowRuntimeOwnerKey = runtimeOwnerKey

type Handler = (event: unknown, ctx: MockContext) => Promise<void> | void
type EventHandler = (event: { ctx?: MockContext }) => void

interface MockContext {
  hasUI?: boolean
  sessionManager: { getEntries: () => unknown[] }
}

interface ExecCall {
  command: string
  args: string[]
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

const ENV_KEY = 'CMUX_WORKSPACE_ID'
const originalEnv = process.env[ENV_KEY]

beforeEach(() => {
  process.env[ENV_KEY] = 'workspace:1'
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalEnv
})

function loadExtension(): (pi: unknown) => void {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} as { default?: (pi: unknown) => void } }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', outputText)(module, module.exports)
  if (!module.exports.default) throw new Error('cmux-sidebar default export not loaded')
  return module.exports.default
}

function flush(): Promise<void> {
  return new Promise(resolveFlush => setTimeout(resolveFlush, 0))
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await flush()
}

function createHarness(options: {
  bd?: (beadId: string) => Promise<ExecResult> | ExecResult
  cmux?: (args: string[]) => Promise<ExecResult> | ExecResult
  getEntries?: () => unknown[]
  hasUI?: boolean | 'omit'
} = {}) {
  const handlers: Record<string, Handler> = {}
  const eventHandlers: Record<string, EventHandler> = {}
  const calls: ExecCall[] = []
  let entries: unknown[] = []
  const extension = loadExtension()

  const defaultBd = async (): Promise<ExecResult> => ({
    code: 0,
    stdout: JSON.stringify([{ title: 'Resolved bead title' }]),
    stderr: '',
  })
  const defaultCmux = async (): Promise<ExecResult> => ({ code: 0, stdout: '', stderr: '' })

  const pi = {
    events: {
      on: (event: string, handler: EventHandler) => {
        eventHandlers[event] = handler
      },
    },
    on: (event: string, handler: Handler) => {
      handlers[event] = handler
    },
    exec: async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === 'bd') {
        const beadId = args[1] ?? ''
        return await (options.bd ?? defaultBd)(beadId)
      }
      if (command === 'cmux') {
        return await (options.cmux ?? defaultCmux)(args)
      }
      return { code: 1, stdout: '', stderr: `unknown command ${command}` }
    },
  }

  extension(pi)

  function setEntries(data: unknown | unknown[] | undefined): void {
    if (data === undefined) {
      entries = []
      return
    }
    if (Array.isArray(data) && data.every(item => item && typeof item === 'object' && 'type' in (item as object))) {
      entries = (data as Array<Record<string, unknown>>).map(entry => {
        if (entry.type === 'custom' && entry.customType === 'workflow-state' && entry.data && typeof entry.data === 'object') {
          const dataObj = entry.data as Record<string, unknown>
          return {
            ...entry,
            data: {
              ...dataObj,
              runtimeOwnerKey: dataObj.runtimeOwnerKey ?? runtimeOwnerKey,
            },
          }
        }
        return entry
      })
      return
    }
    entries = [{
      type: 'custom',
      customType: 'workflow-state',
      data: { ...(data as Record<string, unknown>), runtimeOwnerKey },
    }]
  }

  function ctx(data?: unknown | unknown[]): MockContext {
    if (data !== undefined) setEntries(data)
    const base: MockContext = {
      sessionManager: {
        getEntries: options.getEntries ?? (() => entries),
      },
    }
    if (options.hasUI === 'omit') return base
    base.hasUI = options.hasUI ?? true
    return base
  }

  async function trigger(name: keyof typeof handlers | 'workflow-state:update', data?: unknown | unknown[]): Promise<MockContext> {
    const context = ctx(data)
    if (name === 'workflow-state:update') {
      eventHandlers['workflow-state:update']?.({ ctx: context })
    }
    else {
      await handlers[name as string]?.({}, context)
    }
    await settle()
    return context
  }

  function cmuxCalls(): ExecCall[] {
    return calls.filter(call => call.command === 'cmux')
  }

  function bdCalls(): ExecCall[] {
    return calls.filter(call => call.command === 'bd')
  }

  function resetCalls(): void {
    calls.length = 0
  }

  return {
    handlers,
    eventHandlers,
    calls,
    cmuxCalls,
    bdCalls,
    resetCalls,
    setEntries,
    ctx,
    trigger,
  }
}

function expectSetStatus(call: ExecCall | undefined, pill: string, icon: string, color: string, workspace = 'workspace:1'): void {
  expect(call).toEqual({
    command: 'cmux',
    args: ['set-status', 'task', pill, '--workspace', workspace, '--icon', icon, '--color', color],
  })
}

function expectSetProgress(call: ExecCall | undefined, progress: string, label: string, workspace = 'workspace:1'): void {
  expect(call).toEqual({
    command: 'cmux',
    args: ['set-progress', progress, '--label', label, '--workspace', workspace],
  })
}

function expectSetDescription(call: ExecCall | undefined, title: string, workspace = 'workspace:1'): void {
  expect(call).toEqual({
    command: 'cmux',
    args: ['workspace-action', '--action', 'set-description', '--description', title, '--workspace', workspace],
  })
}

function expectClearTriple(calls: ExecCall[], workspace = 'workspace:1'): void {
  expect(calls).toEqual([
    { command: 'cmux', args: ['clear-status', 'task', '--workspace', workspace] },
    { command: 'cmux', args: ['clear-progress', '--workspace', workspace] },
    { command: 'cmux', args: ['workspace-action', '--action', 'clear-description', '--workspace', workspace] },
  ])
}

describe('cmux-sidebar extension', () => {
  it('a) claim entry + tool_result → exact argv set×3', async () => {
    const h = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Claimed title' }]), stderr: '' }),
    })

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-abcd',
      state: 'claimed',
      sessionMode: 'claimed',
    })

    const cmux = h.cmuxCalls()
    expect(cmux).toHaveLength(3)
    expectSetStatus(cmux[0], 'abcd · Claimed title', 'circle.fill', '#0a84ff')
    expectSetProgress(cmux[1], '0.15', 'взята')
    expectSetDescription(cmux[2], 'Claimed title')
    expect(h.bdCalls()).toEqual([{ command: 'bd', args: ['show', 'beads-task-issue-tracker-abcd', '--json'] }])
  })

  it('a2) UNBOUND leftover sessionMode + state=claimed + bead → claimed visual (not 0 cmux)', async () => {
    const h = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Unbound claim title' }]), stderr: '' }),
    })

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-unbd',
      state: 'claimed',
      sessionMode: 'UNBOUND_WORKFLOW_STATE',
    })

    const cmux = h.cmuxCalls()
    expect(cmux).toHaveLength(3)
    expectSetStatus(cmux[0], 'unbd · Unbound claim title', 'circle.fill', '#0a84ff')
    expectSetProgress(cmux[1], '0.15', 'взята')
    expectSetDescription(cmux[2], 'Unbound claim title')
  })

  it('a3) both-unmapped leftover sessionMode+state + bead → no-op (0 cmux)', async () => {
    const h = createHarness()
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-both',
      state: 'idle',
      sessionMode: 'UNBOUND_WORKFLOW_STATE',
    })
    expect(h.cmuxCalls()).toEqual([])
    expect(h.bdCalls()).toEqual([])
  })

  it('b) claimed→implementing on one harness, zero second bd show', async () => {
    const h = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Stable title' }]), stderr: '' }),
    })

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-abcd',
      state: 'claimed',
      sessionMode: 'claimed',
    })
    expect(h.bdCalls()).toHaveLength(1)
    h.resetCalls()

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-abcd',
      state: 'implementing',
      sessionMode: 'implementing',
    })

    expect(h.bdCalls()).toHaveLength(0)
    const cmux = h.cmuxCalls()
    expect(cmux).toHaveLength(3)
    expectSetStatus(cmux[0], 'abcd · Stable title', 'hammer', '#ff9500')
    expectSetProgress(cmux[1], '0.60', 'работа')
    expectSetDescription(cmux[2], 'Stable title')
  })

  it('c) sessionMode-only inreview + table-driven planning/plan_approved/reviewing', async () => {
    const cases = [
      { mode: 'inreview', icon: 'eye', color: '#ffd60a', progress: '0.80', labelRu: 'на ревью' },
      { mode: 'planning', icon: 'circle.fill', color: '#0a84ff', progress: '0.30', labelRu: 'план' },
      { mode: 'plan_approved', icon: 'checkmark.circle', color: '#0a84ff', progress: '0.45', labelRu: 'план ок' },
      { mode: 'reviewing', icon: 'eyeglasses', color: '#ffd60a', progress: '0.90', labelRu: 'ревью' },
    ] as const

    for (const row of cases) {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify({ title: `${row.mode} title` }), stderr: '' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-mode',
        sessionMode: row.mode,
      })
      const cmux = h.cmuxCalls()
      expect(cmux).toHaveLength(3)
      expectSetStatus(cmux[0], `mode · ${row.mode} title`, row.icon, row.color)
      expectSetProgress(cmux[1], row.progress, row.labelRu)
      expectSetDescription(cmux[2], `${row.mode} title`)
    }
  })

  it('d) sessionMode-only merged/deferred → clear×3; closed with bead → landing', async () => {
    for (const mode of ['merged', 'deferred'] as const) {
      const h = createHarness()
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-term',
        sessionMode: mode,
      })
      expectClearTriple(h.cmuxCalls())
      expect(h.bdCalls()).toHaveLength(0)
    }

    const closed = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify({ title: 'Closed title' }), stderr: '' }),
    })
    await closed.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-term',
      sessionMode: 'closed',
    })
    const cmux = closed.cmuxCalls()
    expect(cmux).toHaveLength(3)
    expectSetStatus(cmux[0], 'term · Closed title', 'arrow.up.circle', '#0a84ff')
    expectSetProgress(cmux[1], '0.98', 'нужен merge')
    expectSetDescription(cmux[2], 'Closed title')
  })

  it('e) owned entry without activeBead and empty lastApplied → no-op (agent never-set)', async () => {
    const h = createHarness()
    await h.trigger('tool_result', { state: 'implementing', sessionMode: 'implementing' })
    expect(h.cmuxCalls()).toEqual([])
    expect(h.bdCalls()).toEqual([])
  })

  it('e2) own set/blocked/suffix-only → reset → clear×3; second idle → 0 cmux', async () => {
    // Full set (title present)
    {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Owner title' }]), stderr: '' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-own1',
        sessionMode: 'claimed',
      })
      expect(h.cmuxCalls()).toHaveLength(3)
      h.resetCalls()

      await h.trigger('tool_result', { state: 'idle', sessionMode: 'idle' })
      expectClearTriple(h.cmuxCalls())
      h.resetCalls()

      await h.trigger('tool_result', { state: 'idle', sessionMode: 'idle' })
      expect(h.cmuxCalls()).toEqual([])
    }

    // Blocked set (title present → action set)
    {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Blocked owner' }]), stderr: '' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-own2',
        sessionMode: 'blocked',
      })
      expect(h.cmuxCalls()).toHaveLength(3)
      h.resetCalls()

      await h.trigger('tool_result', { state: 'idle', sessionMode: 'idle' })
      expectClearTriple(h.cmuxCalls())
      h.resetCalls()

      await h.trigger('tool_result', { state: 'idle', sessionMode: 'idle' })
      expect(h.cmuxCalls()).toEqual([])
    }

    // Suffix-only set (bd fail → action set-suffix-only)
    {
      const h = createHarness({
        bd: async () => ({ code: 1, stdout: '', stderr: 'missing' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-own3',
        sessionMode: 'claimed',
      })
      expect(h.cmuxCalls()).toHaveLength(2)
      h.resetCalls()

      await h.trigger('tool_result', { state: 'idle', sessionMode: 'idle' })
      expectClearTriple(h.cmuxCalls())
      h.resetCalls()

      await h.trigger('tool_result', { state: 'idle', sessionMode: 'idle' })
      expect(h.cmuxCalls()).toEqual([])
    }
  })

  it('f) session_start hydration', async () => {
    const h = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Hydrated' }]), stderr: '' }),
    })
    await h.trigger('session_start', {
      activeBead: 'beads-task-issue-tracker-hydr',
      state: 'claimed',
      sessionMode: 'claimed',
    })
    const cmux = h.cmuxCalls()
    expect(cmux).toHaveLength(3)
    expectSetStatus(cmux[0], 'hydr · Hydrated', 'circle.fill', '#0a84ff')
  })

  it('g) accepted/landing + activeBead → set; idle + activeBead → no-op', async () => {
    const mapped = [
      { mode: 'accepted', icon: 'checkmark.circle', color: '#30d158', progress: '0.95', labelRu: 'принята' },
      { mode: 'landing', icon: 'arrow.up.circle', color: '#0a84ff', progress: '0.98', labelRu: 'нужен merge' },
    ] as const

    for (const row of mapped) {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify({ title: `${row.mode} title` }), stderr: '' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-left',
        state: row.mode,
        sessionMode: row.mode,
      })
      const cmux = h.cmuxCalls()
      expect(cmux).toHaveLength(3)
      expectSetStatus(cmux[0], `left · ${row.mode} title`, row.icon, row.color)
      expectSetProgress(cmux[1], row.progress, row.labelRu)
      expectSetDescription(cmux[2], `${row.mode} title`)
    }

    const idle = createHarness()
    await idle.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-left',
      state: 'idle',
      sessionMode: 'idle',
    })
    expect(idle.cmuxCalls()).toEqual([])
    expect(idle.bdCalls()).toEqual([])
  })

  it('g2) inreview → accepted + bead updates pill (no short-circuit leftover)', async () => {
    const h = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify({ title: 'Accepted title' }), stderr: '' }),
    })
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-acc',
      sessionMode: 'inreview',
    })
    expect(h.cmuxCalls()).toHaveLength(3)
    expectSetStatus(h.cmuxCalls()[0], 'acc · Accepted title', 'eye', '#ffd60a')
    expectSetProgress(h.cmuxCalls()[1], '0.80', 'на ревью')
    h.resetCalls()

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-acc',
      sessionMode: 'accepted',
    })
    const cmux = h.cmuxCalls()
    expect(cmux).toHaveLength(3)
    expectSetStatus(cmux[0], 'acc · Accepted title', 'checkmark.circle', '#30d158')
    expectSetProgress(cmux[1], '0.95', 'принята')
    expectSetDescription(cmux[2], 'Accepted title')
  })

  it('g3) after-set closed without bead → landing; merged clear; never-set closed → 0 cmux', async () => {
    // closed-waiting-merge without bead keeps landing pill from lastApplied (no bd show)
    {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify({ title: 'Owned set' }), stderr: '' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-ownc',
        sessionMode: 'inreview',
      })
      expect(h.cmuxCalls()).toHaveLength(3)
      expectSetStatus(h.cmuxCalls()[0], 'ownc · Owned set', 'eye', '#ffd60a')
      h.resetCalls()

      await h.trigger('tool_result', { state: 'closed', sessionMode: 'closed' })
      const landing = h.cmuxCalls()
      expect(landing).toHaveLength(3)
      expectSetStatus(landing[0], 'ownc · Owned set', 'arrow.up.circle', '#0a84ff')
      expectSetProgress(landing[1], '0.98', 'нужен merge')
      expectSetDescription(landing[2], 'Owned set')
      expect(h.bdCalls()).toHaveLength(0)
      h.resetCalls()

      // second refresh with same landing signature → 0 cmux
      await h.trigger('tool_result', { state: 'closed', sessionMode: 'closed' })
      expect(h.cmuxCalls()).toEqual([])
      expect(h.bdCalls()).toEqual([])
    }

    // merged without bead clears after prior set (including after intermediate landing)
    {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify({ title: 'Owned set' }), stderr: '' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-ownm',
        sessionMode: 'inreview',
      })
      expect(h.cmuxCalls()).toHaveLength(3)
      h.resetCalls()

      await h.trigger('tool_result', { state: 'closed', sessionMode: 'closed' })
      expect(h.cmuxCalls()).toHaveLength(3)
      expectSetProgress(h.cmuxCalls()[1], '0.98', 'нужен merge')
      h.resetCalls()

      await h.trigger('tool_result', { state: 'merged', sessionMode: 'merged' })
      expectClearTriple(h.cmuxCalls())
    }

    // blocked without bead after own set → clear×3
    {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify({ title: 'Owned set' }), stderr: '' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-ownb',
        sessionMode: 'implementing',
      })
      expect(h.cmuxCalls()).toHaveLength(3)
      h.resetCalls()

      await h.trigger('tool_result', { state: 'blocked', sessionMode: 'blocked' })
      expectClearTriple(h.cmuxCalls())
    }

    // never-set agent: terminal without prior set must not wipe shared sidebar
    const neverSet = createHarness()
    await neverSet.trigger('tool_result', { state: 'closed', sessionMode: 'closed' })
    expect(neverSet.cmuxCalls()).toEqual([])
    expect(neverSet.bdCalls()).toEqual([])
  })

  it('g4) landing-without-bead then claim next → claimed visual', async () => {
    const h = createHarness({
      bd: async (beadId) => {
        if (beadId.includes('next')) {
          return { code: 0, stdout: JSON.stringify({ title: 'Next bead title' }), stderr: '' }
        }
        return { code: 0, stdout: JSON.stringify({ title: 'Prior title' }), stderr: '' }
      },
    })
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-prior',
      sessionMode: 'accepted',
    })
    expect(h.cmuxCalls()).toHaveLength(3)
    h.resetCalls()

    await h.trigger('tool_result', { state: 'closed', sessionMode: 'closed' })
    expectSetProgress(h.cmuxCalls()[1], '0.98', 'нужен merge')
    expect(h.bdCalls()).toHaveLength(0)
    h.resetCalls()

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-next',
      state: 'claimed',
      sessionMode: 'claimed',
    })
    const cmux = h.cmuxCalls()
    expect(cmux).toHaveLength(3)
    expectSetStatus(cmux[0], 'next · Next bead title', 'circle.fill', '#0a84ff')
    expectSetProgress(cmux[1], '0.15', 'взята')
    expectSetDescription(cmux[2], 'Next bead title')
  })

  it('h) missing/empty CMUX_WORKSPACE_ID → identify once, failure cache, retry on session_start, success workspace:7', async () => {
    delete process.env[ENV_KEY]
    let identifyCount = 0
    const h = createHarness({
      cmux: async (args) => {
        if (args[0] === 'identify') {
          identifyCount += 1
          if (identifyCount === 1) return { code: 1, stdout: '', stderr: 'no socket' }
          return {
            code: 0,
            stdout: JSON.stringify({ caller: { workspace_ref: 'workspace:7' } }),
            stderr: '',
          }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Outside cmux' }]), stderr: '' }),
    })

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-noid',
      sessionMode: 'claimed',
    })
    expect(identifyCount).toBe(1)
    expect(h.cmuxCalls().filter(c => c.args[0] !== 'identify')).toEqual([])
    h.resetCalls()

    // Failure is cached until session_start: second tool_result must not re-identify.
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-noid',
      sessionMode: 'claimed',
    })
    expect(identifyCount).toBe(1)
    expect(h.cmuxCalls()).toEqual([])
    h.resetCalls()

    await h.trigger('session_start', {
      activeBead: 'beads-task-issue-tracker-noid',
      sessionMode: 'claimed',
    })
    expect(identifyCount).toBe(2)
    const setCalls = h.cmuxCalls().filter(c => c.args[0] !== 'identify')
    expect(setCalls).toHaveLength(3)
    expectSetStatus(setCalls[0], 'noid · Outside cmux', 'circle.fill', '#0a84ff', 'workspace:7')
    expectSetProgress(setCalls[1], '0.15', 'взята', 'workspace:7')
    expectSetDescription(setCalls[2], 'Outside cmux', 'workspace:7')

    // Empty string env is also missing.
    process.env[ENV_KEY] = ''
    const hEmpty = createHarness({
      cmux: async (args) => {
        if (args[0] === 'identify') return { code: 1, stdout: '', stderr: 'fail' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    await hEmpty.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-empty',
      sessionMode: 'claimed',
    })
    expect(hEmpty.cmuxCalls().some(c => c.args[0] === 'identify')).toBe(true)
    expect(hEmpty.cmuxCalls().filter(c => c.args[0] !== 'identify')).toEqual([])
  })

  it('i) bd fail → suffix-only, retry on next refresh', async () => {
    let bdCode = 1
    const h = createHarness({
      bd: async () => ({
        code: bdCode,
        stdout: bdCode === 0 ? JSON.stringify([{ title: 'Recovered title' }]) : '',
        stderr: bdCode === 0 ? '' : 'missing',
      }),
    })

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-fail',
      sessionMode: 'claimed',
    })
    let cmux = h.cmuxCalls()
    expect(cmux).toHaveLength(2)
    expectSetStatus(cmux[0], 'fail', 'circle.fill', '#0a84ff')
    expectSetProgress(cmux[1], '0.15', 'взята')
    expect(cmux.some(c => c.args.includes('set-description'))).toBe(false)
    h.resetCalls()

    bdCode = 0
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-fail',
      sessionMode: 'claimed',
    })
    cmux = h.cmuxCalls()
    expect(cmux).toHaveLength(3)
    expectSetStatus(cmux[0], 'fail · Recovered title', 'circle.fill', '#0a84ff')
    expectSetDescription(cmux[2], 'Recovered title')
  })

  it('j) short-circuit by signature + failed apply is not cached', async () => {
    let failProgress = false
    const h = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Sig title' }]), stderr: '' }),
      cmux: async (args) => {
        if (failProgress && args[0] === 'set-progress') return { code: 1, stdout: '', stderr: 'fail' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-sig',
      sessionMode: 'claimed',
    })
    expect(h.cmuxCalls()).toHaveLength(3)
    h.resetCalls()

    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-sig',
      sessionMode: 'claimed',
    })
    expect(h.cmuxCalls()).toEqual([])
    expect(h.bdCalls()).toEqual([])
    h.resetCalls()

    failProgress = true
    // Force different signature first so apply runs, then fail mid-apply.
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-sig',
      sessionMode: 'implementing',
    })
    expect(h.cmuxCalls().some(c => c.args[0] === 'set-status')).toBe(true)
    expect(h.cmuxCalls().some(c => c.args[0] === 'set-progress')).toBe(true)
    expect(h.cmuxCalls().some(c => c.args.includes('set-description'))).toBe(false)
    h.resetCalls()

    failProgress = false
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-sig',
      sessionMode: 'implementing',
    })
    // Failed apply was not cached → retry full set×3.
    expect(h.cmuxCalls()).toHaveLength(3)
  })

  it('k) truncate only title (40/41/emoji), description stays full', async () => {
    const exact40 = 'A'.repeat(40)
    const over41 = 'B'.repeat(41)
    const emoji = '🚀'.repeat(41)

    {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: exact40 }]), stderr: '' }),
      })
      await h.trigger('tool_result', { activeBead: 'beads-task-issue-tracker-cut', sessionMode: 'claimed' })
      expectSetStatus(h.cmuxCalls()[0], `cut · ${exact40}`, 'circle.fill', '#0a84ff')
      expectSetDescription(h.cmuxCalls()[2], exact40)
    }
    {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: over41 }]), stderr: '' }),
      })
      await h.trigger('tool_result', { activeBead: 'beads-task-issue-tracker-cut', sessionMode: 'claimed' })
      expectSetStatus(h.cmuxCalls()[0], `cut · ${'B'.repeat(39)}…`, 'circle.fill', '#0a84ff')
      expectSetDescription(h.cmuxCalls()[2], over41)
    }
    {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: emoji }]), stderr: '' }),
      })
      await h.trigger('tool_result', { activeBead: 'beads-task-issue-tracker-cut', sessionMode: 'claimed' })
      expectSetStatus(h.cmuxCalls()[0], `cut · ${'🚀'.repeat(39)}…`, 'circle.fill', '#0a84ff')
      expectSetDescription(h.cmuxCalls()[2], emoji)
    }
  })

  it('l) settings.json entry after bead-purpose and extension file exists', () => {
    const settings = JSON.parse(settingsSource) as { extensions: string[] }
    const purposeIdx = settings.extensions.indexOf('extensions/bead-purpose/index.ts')
    const sidebarIdx = settings.extensions.indexOf('extensions/cmux-sidebar/index.ts')
    expect(purposeIdx).toBeGreaterThanOrEqual(0)
    expect(sidebarIdx).toBe(purposeIdx + 1)
    expect(existsSync(resolve(__dirname, '../../.pi/extensions/cmux-sidebar/index.ts'))).toBe(true)
  })

  it('m) blocked fixtures → xmark + clear-progress, no set-progress, no clear-description; implementing→blocked clean', async () => {
    for (const data of [
      { activeBead: 'beads-task-issue-tracker-blok', sessionMode: 'blocked' },
      { activeBead: 'beads-task-issue-tracker-blok', state: 'blocked' },
    ]) {
      const h = createHarness({
        bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Blocked title' }]), stderr: '' }),
      })
      await h.trigger('tool_result', data)
      const cmux = h.cmuxCalls()
      expect(cmux).toHaveLength(3)
      expectSetStatus(cmux[0], 'blok · Blocked title', 'xmark.octagon', '#ff453a')
      expect(cmux[1]).toEqual({ command: 'cmux', args: ['clear-progress', '--workspace', 'workspace:1'] })
      expectSetDescription(cmux[2], 'Blocked title')
      expect(cmux.some(c => c.args[0] === 'set-progress')).toBe(false)
      expect(cmux.some(c => c.args.includes('clear-description'))).toBe(false)
    }

    const h = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Transition title' }]), stderr: '' }),
    })
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-blok',
      sessionMode: 'implementing',
    })
    h.resetCalls()
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-blok',
      sessionMode: 'blocked',
    })
    const cmux = h.cmuxCalls()
    expect(cmux.some(c => c.args[0] === 'set-progress')).toBe(false)
    expect(cmux.some(c => c.args.includes('clear-description'))).toBe(false)
    expect(cmux.some(c => c.args[0] === 'clear-progress')).toBe(true)
    expectSetStatus(cmux[0], 'blok · Transition title', 'xmark.octagon', '#ff453a')
  })

  it('n) hasUI false/omitted still set×3', async () => {
    for (const hasUI of [false, 'omit'] as const) {
      const h = createHarness({
        hasUI,
        bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'No UI guard' }]), stderr: '' }),
      })
      await h.trigger('tool_result', {
        activeBead: 'beads-task-issue-tracker-noui',
        sessionMode: 'claimed',
      })
      expect(h.cmuxCalls()).toHaveLength(3)
    }
  })

  it('o) throw in snapshot/title path keeps queue alive', async () => {
    let blow = true
    const h = createHarness({
      getEntries: () => {
        if (blow) throw new Error('snapshot boom')
        return [{
          type: 'custom',
          customType: 'workflow-state',
          data: {
            activeBead: 'beads-task-issue-tracker-live',
            sessionMode: 'claimed',
            runtimeOwnerKey,
          },
        }]
      },
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Alive' }]), stderr: '' }),
    })

    await h.trigger('tool_result')
    expect(h.cmuxCalls()).toEqual([])
    blow = false
    await h.trigger('tool_result')
    expect(h.cmuxCalls()).toHaveLength(3)
  })

  it('p) empty getEntries with prior claimed last-applied → zero exec (no-op, not clear)', async () => {
    const h = createHarness({
      bd: async () => ({ code: 0, stdout: JSON.stringify([{ title: 'Prior' }]), stderr: '' }),
    })
    await h.trigger('tool_result', {
      activeBead: 'beads-task-issue-tracker-prior',
      sessionMode: 'claimed',
    })
    expect(h.cmuxCalls()).toHaveLength(3)
    h.resetCalls()
    h.setEntries(undefined)
    await h.trigger('tool_result')
    expect(h.cmuxCalls()).toEqual([])
    expect(h.bdCalls()).toEqual([])
  })

  it('p2) only foreign runtimeOwnerKey entries → zero set/clear', async () => {
    const h = createHarness()
    await h.trigger('tool_result', [
      {
        type: 'custom',
        customType: 'workflow-state',
        data: {
          activeBead: 'beads-task-issue-tracker-frgn',
          sessionMode: 'claimed',
          runtimeOwnerKey: 'runtime:foreign-owner',
        },
      },
    ])
    expect(h.cmuxCalls()).toEqual([])
    expect(h.bdCalls()).toEqual([])
  })

  it('q) in-flight claimed with deferred bd + owned idle before resolve → claimed set×3 dropped; idle no-op (never applied)', async () => {
    let resolveBd!: (value: ExecResult) => void
    const h = createHarness({
      bd: () => new Promise<ExecResult>(resolve => {
        resolveBd = resolve
      }),
    })

    const claimedCtx = h.ctx({
      activeBead: 'beads-task-issue-tracker-race',
      sessionMode: 'claimed',
    })
    // Start claimed refresh without awaiting settle (bd deferred).
    h.handlers.tool_result?.({}, claimedCtx)
    await flush()

    // Supersede with owned idle/reset before bd resolves.
    // lastApplied never cached a set → ownership-gated clear is a no-op.
    h.setEntries({ state: 'idle', sessionMode: 'idle' })
    h.handlers.tool_result?.({}, h.ctx())
    await flush()

    resolveBd({ code: 0, stdout: JSON.stringify([{ title: 'Stale claimed title' }]), stderr: '' })
    await settle(20)

    const cmux = h.cmuxCalls()
    expect(cmux.some(c => c.args[0] === 'set-status')).toBe(false)
    expect(cmux.some(c => c.args[0] === 'set-progress')).toBe(false)
    expect(cmux.some(c => c.args.includes('set-description'))).toBe(false)
    expect(cmux.some(c => c.args[0] === 'clear-status')).toBe(false)
    expect(cmux).toEqual([])
  })
})
