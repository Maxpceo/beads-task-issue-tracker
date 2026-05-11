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

interface MockContext {
  cwd: string
  hasUI: true
  sessionManager: { getEntries: () => unknown[] }
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

async function renderDashboard(cwd: string, workflowState: Record<string, unknown> = {}, width = 120): Promise<{ status: string; footer: string[]; bdCalls: string[] }> {
  const handlers: RegisteredHandlers = {}
  let status = ''
  let footer: { render: (width: number) => string[] } | undefined
  const theme = { fg: (_color: string, text: string) => text }
  const bdCalls: string[] = []
  const pi = {
    on(event: keyof RegisteredHandlers, handler: RegisteredHandlers[typeof event]) {
      handlers[event] = handler
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
      getEntries: () => (Object.keys(workflowState).length > 0 ? [{ type: 'custom', customType: 'workflow-state', data: workflowState }] : []),
    },
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

  return { status, footer: footer?.render(width) ?? [], bdCalls }
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
    const workflowLine = dashboard.footer[0] ?? ''

    expect(dashboard.status).toContain('wt:')
    expect(workflowLine).toContain('wt:')
  })
})
