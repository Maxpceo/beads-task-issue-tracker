import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions/status-dashboard.ts'), 'utf8')

function loadStatusDashboardExtension(): (pi: unknown) => void {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} as { default?: (pi: unknown) => void } }
  const mockRequire = (id: string) => {
    if (id === '@earendil-works/pi-tui') {
      return {
        truncateToWidth: (text: string, maxWidth: number, ellipsis = '…') => {
          if (text.length <= maxWidth) return text
          if (maxWidth <= 0) return ''
          if (maxWidth === 1) return ellipsis
          return `${text.slice(0, maxWidth - ellipsis.length)}${ellipsis}`
        },
        visibleWidth: (text: string) => text.length,
      }
    }
    throw new Error(`Unexpected require: ${id}`)
  }
  new Function('require', 'module', 'exports', outputText)(mockRequire, module, module.exports)
  if (!module.exports.default) throw new Error('status-dashboard default export not loaded')
  return module.exports.default
}

interface RegisteredHandlers {
  turn_start?: (event: unknown, ctx: MockContext) => Promise<void> | void
}

interface ContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

interface MockContext {
  cwd: string
  hasUI: true
  sessionManager: { getEntries: () => unknown[] }
  getContextUsage: () => ContextUsage | undefined
  model?: { contextWindow?: number }
  ui: {
    theme: { fg: (_color: string, text: string) => string }
    setStatus: (key: string, text: string) => void
    setFooter: (factory: (tui: { requestRender: () => void }, theme: { fg: (_color: string, text: string) => string }, footerData: { getExtensionStatuses: () => Map<string, string> }) => { render: (width: number) => string[] }) => void
    notify: () => void
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRepoWithLinkedWorktree(): { primary: string; linked: string; linkedName: string } {
  const base = mkdtempSync(join(tmpdir(), 'pi-status-dashboard-'))
  tempDirs.push(base)
  const primary = join(base, 'primary')
  const linkedName = 'linked-dashboard-wt'
  const linked = join(base, linkedName)

  git(base, ['init', primary])
  git(primary, ['config', 'user.email', 'pi@example.test'])
  git(primary, ['config', 'user.name', 'Pi Test'])
  execFileSync('sh', ['-c', 'printf test > file.txt'], { cwd: primary })
  git(primary, ['add', 'file.txt'])
  git(primary, ['commit', '-m', 'initial'])
  git(primary, ['worktree', 'add', '-b', 'linked-dashboard-branch', linked])

  return { primary, linked, linkedName }
}

const LONG_STATE = {
  sessionMode: 'implementing',
  state: 'claimed',
  activeBead: 'beads-task-issue-tracker-current',
  bdStatus: 'custom_review_hold',
  planMode: 'strict',
  planApproved: true,
  mergeSlotHeld: true,
} as const

function hasField(text: string, key: string): boolean {
  return new RegExp(`(^|\\s)${key}:`).test(text)
}

async function renderDashboard(cwd: string, workflowState: Record<string, unknown> | Array<{ type: string; customType?: string; data?: unknown }> = {}, width = 120, contextUsage?: ContextUsage): Promise<{ status: string; footer: string[]; footerAt: (w: number) => string[]; bdCalls: string[]; emitWorkflowUpdate: (entries: Array<{ type: string; customType?: string; data?: unknown }>) => Promise<void> }> {
  const runtimeOwnerKey = 'runtime:test-status-dashboard'
  ;(globalThis as typeof globalThis & { __piWorkflowRuntimeOwnerKey?: string }).__piWorkflowRuntimeOwnerKey = runtimeOwnerKey
  if (!Array.isArray(workflowState) && Object.keys(workflowState).length > 0) workflowState.runtimeOwnerKey ??= runtimeOwnerKey
  const workflowEntries = Array.isArray(workflowState)
    ? [...workflowState]
    : Object.keys(workflowState).length > 0
      ? [{ type: 'custom', customType: 'workflow-state', data: workflowState }]
      : []
  const handlers: RegisteredHandlers = {}
  const eventHandlers = new Map<string, (event: any) => Promise<void> | void>()
  let status = ''
  let footer: { render: (width: number) => string[] } | undefined
  const theme = { fg: (_color: string, text: string) => text }
  const bdCalls: string[] = []
  const pi = {
    on(event: keyof RegisteredHandlers, handler: RegisteredHandlers[typeof event]) {
      handlers[event] = handler
    },
    events: {
      on: (name: string, handler: (event: any) => Promise<void> | void) => eventHandlers.set(name, handler),
    },
    registerCommand() {},
    async exec(command: string, args: string[]) {
      if (command === 'bd') {
        bdCalls.push(args.join(' '))
        if (args.join(' ') === 'list --status in_progress --json') return { stdout: JSON.stringify([{ id: 'beads-task-issue-tracker-foreign', started_at: '2026-01-01T00:00:00Z' }]), stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 1 }
      }
      try {
        return { stdout: execFileSync(command, args, { encoding: 'utf8' }), stderr: '', code: 0 }
      } catch (error) {
        return { stdout: '', stderr: String(error), code: 1 }
      }
    },
  }
  const ctx: MockContext = {
    cwd,
    hasUI: true,
    sessionManager: {
      getEntries: () => workflowEntries,
    },
    getContextUsage: () => contextUsage,
    ui: {
      theme,
      setStatus(key: string, text: string) {
        if (key === 'pi-workflow-dashboard') status = text
      },
      setFooter(factory) {
        footer = factory({ requestRender: () => {} }, theme, { getExtensionStatuses: () => new Map() })
      },
      notify() {},
    },
  }

  const statusDashboardExtension = loadStatusDashboardExtension()
  statusDashboardExtension(pi)
  await handlers.turn_start?.({}, ctx)

  return {
    get status() { return status },
    get footer() { return footer?.render(width) ?? [] },
    footerAt: (w: number) => footer?.render(w) ?? [],
    bdCalls,
    emitWorkflowUpdate: async (entries) => {
      workflowEntries.splice(0, workflowEntries.length, ...entries)
      await eventHandlers.get('workflow-state:update')?.({ ctx })
    },
  }
}

describe('Pi status-dashboard worktree display', () => {
  it('does not render workflow-state worktreePath as a wt override', () => {
    expect(source).not.toContain('wf:${pathBasename(wf.worktreePath)}')
    expect(source).toContain('const worktree = formatWorktree(snapshot.worktree)')
  })

  it('does not fall back to wt:primary in extension status text', () => {
    expect(source).not.toContain('?? "primary"')
    expect(source).toContain('if (statusWorktree) statusParts.push(`wt:${statusWorktree}`)')
  })

  it('does not display a global bd in_progress fallback when workflow has no active bead', async () => {
    const { primary } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary)

    expect(dashboard.status).toContain('bead:-')
    expect(dashboard.status).not.toContain('*')
    expect(dashboard.footer.join('\n')).toContain('bead:-')
    expect(dashboard.footer.join('\n')).not.toContain('*')
    expect(dashboard.bdCalls).not.toContain('list --status in_progress --json')
  })

  it('keeps current runtime workflow when a later foreign runtime reset exists in the shared transcript', async () => {
    const { primary } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary, [
      { type: 'custom', customType: 'workflow-state', data: { runtimeOwnerKey: 'runtime:test-status-dashboard', state: 'implementing', activeBead: 'beads-task-issue-tracker-current', planMode: 'strict', mergeSlotHeld: true } },
      { type: 'custom', customType: 'workflow-state', data: { runtimeOwnerKey: 'runtime:other-live-pane', state: 'idle', planMode: 'off', mergeSlotHeld: false } },
    ])

    expect(dashboard.status).toContain('bead:beads-task-issue-tracker-current')
    expect(dashboard.footer.join('\n')).toContain('bead:current')
    expect(dashboard.footer.join('\n')).toContain('plan:strict/pending')
    expect(dashboard.footer.join('\n')).toContain('slot:held')
  })

  it('displays bd-first session, bd status, approved plan, and slot without wf lifecycle token', async () => {
    const { primary } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary, {
      sessionMode: 'implementing',
      state: 'claimed',
      activeBead: 'beads-task-issue-tracker-current*',
      bdStatus: 'custom_review_hold',
      planMode: 'strict',
      planApproved: true,
      mergeSlotHeld: true,
    })
    const rendered = `${dashboard.status}\n${dashboard.footer.join('\n')}`

    expect(rendered).toContain('session:implementing')
    expect(rendered).toContain('bead:current*')
    expect(rendered).toContain('bd:custom_review_hold')
    expect(rendered).toContain('plan:strict/approved')
    expect(rendered).toContain('slot:held')
    expect(rendered).not.toContain('wf:')
    expect(rendered).not.toContain('state:claimed')
  })

  it('uses latest current-runtime plan and slot after strict to off update', async () => {
    const { primary } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary, [
      { type: 'custom', customType: 'workflow-state', data: { runtimeOwnerKey: 'runtime:test-status-dashboard', state: 'planning', planMode: 'strict', mergeSlotHeld: true } },
      { type: 'custom', customType: 'workflow-state', data: { runtimeOwnerKey: 'runtime:test-status-dashboard', state: 'planning', planMode: 'off', mergeSlotHeld: false } },
    ])

    expect(dashboard.status).toContain('plan:off/pending')
    expect(dashboard.status).toContain('slot:free')
    expect(dashboard.footer.join('\n')).toContain('plan:off/pending')
    expect(dashboard.footer.join('\n')).toContain('slot:free')
    expect(dashboard.footer.join('\n')).not.toContain('plan:strict/')
    expect(dashboard.footer.join('\n')).not.toContain('slot:held')
  })

  it('refreshes status and footer immediately after workflow-state update event', async () => {
    const { primary } = createRepoWithLinkedWorktree()
    const dashboard = await renderDashboard(primary, [
      { type: 'custom', customType: 'workflow-state', data: { runtimeOwnerKey: 'runtime:test-status-dashboard', state: 'idle', planMode: 'off', mergeSlotHeld: false } },
    ])

    expect(dashboard.status).toContain('plan:off/pending')
    expect(dashboard.footer.join('\n')).toContain('plan:off/pending')

    await dashboard.emitWorkflowUpdate([
      { type: 'custom', customType: 'workflow-state', data: { runtimeOwnerKey: 'runtime:test-status-dashboard', state: 'planning', planMode: 'strict', mergeSlotHeld: false } },
    ])

    expect(dashboard.status).toContain('session:planning')
    expect(dashboard.status).toContain('plan:strict/pending')
    expect(dashboard.footer.join('\n')).toContain('session:planning')
    expect(dashboard.footer.join('\n')).toContain('plan:strict/pending')
    expect(dashboard.footer.join('\n')).not.toContain('plan:off/')
  })

  it('reports the current linked worktree basename in status and footer output', async () => {
    const { linked, linkedName } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(linked)

    expect(dashboard.status).toContain(`wt:${linkedName}`)
    expect(dashboard.footer.join('\n')).toContain(`wt:${linkedName}`)
  })

  it('does not report a linked worktree when rendered from the primary checkout', async () => {
    const { primary, linkedName } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary)

    expect(basename(primary)).not.toBe(linkedName)
    expect(dashboard.status).not.toContain(`wt:${linkedName}`)
    expect(dashboard.status).not.toContain('wt:')
    expect(dashboard.footer.join('\n')).not.toContain(`wt:${linkedName}`)
  })

  it('uses a git-validated workflow-state linked worktree path when runtime cwd is primary', async () => {
    const { primary, linked, linkedName } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary, { worktreePath: linked })

    expect(dashboard.status).toContain(`wt:${linkedName}`)
    expect(dashboard.footer.join('\n')).toContain(`wt:${linkedName}`)
  })

  it('does not treat a workflow-state primary checkout path as a linked worktree', async () => {
    const { primary, linkedName } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary, { worktreePath: primary })

    expect(dashboard.status).not.toContain(`wt:${linkedName}`)
    expect(dashboard.status).not.toContain('wt:')
    expect(dashboard.footer.join('\n')).not.toContain('wt:')
  })

  it('keeps the linked worktree indicator visible in a constrained footer width', async () => {
    const { linked } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(linked, {}, 40)
    const rendered = dashboard.footer.join('\n')

    expect(dashboard.status).toContain('wt:')
    expect(rendered).toContain('wt:')
    expect(dashboard.footer[0] ?? '').not.toContain('wt:')
  })

  it('shows used context tokens before session usage in the stats footer line', async () => {
    const { primary } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary, {}, 160, { tokens: 50_000, contextWindow: 200_000, percent: 25 })
    const statsLine = dashboard.footer[1] ?? ''

    expect(statsLine).toContain('ctx:50k/200k')
    expect(statsLine).not.toContain('left:')
    expect(statsLine.indexOf('ctx:')).toBeLessThan(statsLine.indexOf('in:'))
  })

  it('shows unknown used tokens when usage tokens are null', async () => {
    const { primary } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary, {}, 160, { tokens: null, contextWindow: 200_000, percent: null })

    expect(dashboard.footer[1] ?? '').toContain('ctx:?/200k')
  })

  it('omits context tokens when context window is unknown', async () => {
    const { primary } = createRepoWithLinkedWorktree()

    const dashboard = await renderDashboard(primary)
    const statsLine = dashboard.footer[1] ?? ''

    expect(statsLine).not.toContain('ctx:')
    expect(statsLine).not.toContain('left:')
    expect(statsLine).toContain('in:')
  })

  it('renders adaptive density goldens for the frozen long linked fixture', async () => {
    const { linked } = createRepoWithLinkedWorktree()
    const dashboard = await renderDashboard(linked, LONG_STATE, 120)

    const at120 = dashboard.footerAt(120)
    expect(at120).toHaveLength(3)
    expect(at120[0]).toMatch(/^ {2}workflow {2}/)
    expect(at120[0]).toContain('session:implementing')
    expect(at120[0]).toContain('wt:linked-dashboard-wt')
    expect(at120[0]).toContain('bead:current')
    expect(at120[0]).toContain('bd:custom_review_hold')
    expect(at120[0]).toContain('plan:strict/approved')
    expect(at120[1]).toBe('            clean  slot:held')
    expect(at120[2]).toMatch(/^ {2}stats {5}/)
    expect(at120[2]).toContain('cache:')
    expect(hasField(at120[2] ?? '', 'c')).toBe(false)
    expect(at120.join('\n')).not.toContain('…')
    for (const line of at120) expect(line.length).toBeLessThanOrEqual(120)

    const at70 = dashboard.footerAt(70)
    expect(at70).toHaveLength(2)
    expect(at70[0]).toBe('  workflow  s:implementing  b:current  bd:custom_review_hold  sl:held')
    expect(at70[1]).toMatch(/^ {2}stats {5}/)
    expect(hasField(at70[1] ?? '', 'c')).toBe(true)
    expect(at70[1]).not.toContain('cache:')
    expect(at70.join('\n')).not.toMatch(/(^|\s)wt:/)
    expect(at70.join('\n')).not.toContain('plan:')
    expect(at70.join('\n')).not.toContain('session:')

    const at80 = dashboard.footerAt(80)
    expect(at80).toHaveLength(2)
    expect(at80[0]).toMatch(/^ {2}workflow {2}/)
    expect(hasField(at80[0] ?? '', 's')).toBe(true)
    expect(hasField(at80[0] ?? '', 'b')).toBe(true)
    expect(hasField(at80[0] ?? '', 'bd')).toBe(true)
    expect(hasField(at80[0] ?? '', 'sl')).toBe(true)
    expect(at80[0]).toContain('b:current')
    expect(at80[1]).toMatch(/^ {2}stats {5}/)
    expect(hasField(at80[1] ?? '', 'in')).toBe(true)
    expect(hasField(at80[1] ?? '', 'out')).toBe(true)
    expect(hasField(at80[1] ?? '', 'c')).toBe(true)
    expect(at80[1]).not.toContain('cache:')
    expect(at80.join('\n')).not.toMatch(/(^|\s)wt:/)
    expect(at80.join('\n')).not.toContain('session:')

    const at119 = dashboard.footerAt(119)
    expect(at119).toHaveLength(2)
    expect(at119[0]).toMatch(/^ {2}workflow {2}/)
    expect(hasField(at119[0] ?? '', 's')).toBe(true)
    expect(at119.join('\n')).not.toContain('session:')
    expect(at119.join('\n')).not.toMatch(/(^|\s)wt:/)
    expect(hasField(at119[1] ?? '', 'c')).toBe(true)
    expect(at119[1]).not.toContain('cache:')

    const at69 = dashboard.footerAt(69)
    expect(at69).toHaveLength(3)
    expect(at69[0]).toMatch(/^wf /)
    expect(hasField(at69[0] ?? '', 's')).toBe(true)
    expect(hasField(at69[0] ?? '', 'b')).toBe(true)
    expect(hasField(at69[0] ?? '', 'bd')).toBe(true)
    expect(hasField(at69[0] ?? '', 'sl')).toBe(true)
    expect(at69[0]).not.toMatch(/(^|\s)p:/)
    expect(at69[0]).not.toMatch(/(^|\s)wt:/)
    expect(at69[0]).not.toContain('clean')
    expect(at69[1]).toMatch(/^ {3}/)
    expect(at69[1]).toContain('wt:linked-dashboard-wt')
    expect(at69[2]).toMatch(/^st /)
    expect(hasField(at69[2] ?? '', 'in')).toBe(true)
    expect(at69[2]).not.toContain('cache:')
    expect(hasField(at69[2] ?? '', 'c')).toBe(false)

    const at40 = dashboard.footerAt(40)
    expect(at40).toHaveLength(3)
    expect(at40[0]).toBe('wf s:implementing  b:current')
    expect(at40[1]).toBe('   bd:custom_review_hold  sl:held')
    expect(at40[2]).toBe('   wt:linked-dashboard-wt')
    expect(at40.join('\n')).not.toContain('session:')
    expect(at40.join('\n')).not.toContain('cache:')

    const at60 = dashboard.footerAt(60)
    expect(at60.length).toBeLessThanOrEqual(3)
    expect(at60[0]).toMatch(/^wf /)
    expect(hasField(at60.join('\n'), 's')).toBe(true)
    expect(hasField(at60.join('\n'), 'b')).toBe(true)
    expect(hasField(at60.join('\n'), 'bd')).toBe(true)
    expect(hasField(at60.join('\n'), 'sl')).toBe(true)
    expect(at60.join('\n')).toContain('wt:linked-dashboard-wt')
    expect(at60.join('\n')).not.toContain('session:')
    expect(at60.join('\n')).not.toContain('bead:')
    expect(at60.join('\n')).not.toContain('slot:')
    expect(at60[0]).toContain('s:implementing')
    expect(at60[0]).toContain('b:current')
    expect(at60[0]).toContain('bd:custom_review_hold')
    expect(at60[0]).toContain('sl:held')
    expect(at60[1]).toMatch(/^ {3}/)
    expect(at60[1]).toContain('wt:linked-dashboard-wt')
    expect(at60[2]).toMatch(/^st /)
    expect(hasField(at60[2] ?? '', 'in')).toBe(true)
    expect(at60[2]).not.toContain('cache:')
    expect(hasField(at60[2] ?? '', 'c')).toBe(false)

    for (const w of [0, 1, 11, 12, 39, 40, 60, 69, 70, 80, 119, 120]) {
      const rows = dashboard.footerAt(w)
      expect(rows.length).toBeLessThanOrEqual(3)
      expect(rows.join('\n')).not.toContain('…')
      for (const line of rows) expect(line.length).toBeLessThanOrEqual(w)
      if (w === 0) expect(rows).toEqual([])
      if (w > 0 && w < 3 + 's:implementing'.length) expect(rows).toEqual([])
    }
  })

  it('keeps a two-line idle footer at width 120 with the full linked worktree basename', async () => {
    const { linked } = createRepoWithLinkedWorktree()
    const dashboard = await renderDashboard(linked, {}, 120)
    expect(dashboard.footer).toHaveLength(2)
    expect(dashboard.footer.join('\n')).toContain('wt:linked-dashboard-wt')
    expect(dashboard.footer[0]).toMatch(/^ {2}workflow {2}/)
  })
})
