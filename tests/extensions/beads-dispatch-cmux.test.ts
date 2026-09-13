import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import beadsDispatchExtension, {
  buildVisibleChildArgv,
  completeVisibleDispatch,
  findRegistryByTaskId,
  loadRegistry,
  nsDir,
  orchRoot,
  persistIsolationFiles,
  pruneRegistry,
  requestSupervisorDispatch,
  saveRegistry,
  setCmuxAdapterForTests,
  validateVisibleChildArgv,
} from '../../.pi/extensions/beads-dispatch/index'

const currentPlan = `PLAN APPROVED
Approved-by: Test
Approved-at: 2026-05-10T00:00:00Z
START_COMMIT: 68241c7309542b76eff49c3360514fb4110f0a83
Files to change:
- .pi/extensions/beads-dispatch/index.ts
Plan:
1. Align readiness matrix.
Edge-case review:
- Incomplete approved comments still fail.
Worktree / cwd:
- /tmp/project
WORKTREE_LOCK:
- Mutating commands stay inside /tmp/project.
Acceptance:
- Current plan-bead contract passes dispatch readiness.
Verification / acceptance checks:
- pnpm test -- tests/extensions/beads-dispatch.test.ts exits 0.
Risks / rollback:
- Revert readiness matrix changes.
AUTO_EXECUTE_ALLOWED: true`

function description(files: string[]) {
  return `### Origin
- Test fixture.
### Files
${files.map((file) => `- ${file}`).join('\n')}
### Current state
- Rules are not injected.
### Target state
- Rules are injected.
### Investigation findings
- src-tauri/CLAUDE.md exists.
### Decisions
- Use path-rule loader.
### Rejected alternatives
- Agent-only loading.
### Dependencies / blockers
- none.
### Acceptance criteria
- PATH_RULES_LOADED contains the sentinel or src-tauri rule.
### Verification / acceptance checks
- dispatch dryRun output contains inline rule content.
### Out of scope
- Running a real subagent.`
}

function currentBranch(cwd = process.cwd()) {
  return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim() || 'task/current'
}

function workflowCtx(cwd: string, beadId: string, branch: string, startCommit: string) {
  return {
    cwd,
    sessionManager: {
      getEntries: () => [{ type: 'custom', customType: 'workflow-state', data: { activeBead: beadId, branch, worktreePath: cwd, startCommit, sessionKey: 'session:test' } }],
    },
  }
}

function makePi(opts: { toolName?: string; execCalls?: Array<{ command: string; args: string[] }>; cwd?: string; branch?: string; head?: string; beadId?: string }) {
  const toolName = opts.toolName ?? 'dispatch_supervisor'
  const execCalls = opts.execCalls ?? []
  const cwd = opts.cwd ?? process.cwd()
  const branch = opts.branch ?? currentBranch(cwd)
  const head = opts.head ?? 'abc1234'
  const beadId = opts.beadId ?? 'bead-a'
  let registered: any
  const tools: Record<string, any> = {}
  const pi = {
    events: { emit() {} },
    registerTool(tool: any) {
      tools[tool.name] = tool
      if (tool.name === toolName) registered = tool
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: beadId, status: 'in_progress', labels: ['dx'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
      if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
      if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : `${head}\n`, stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    },
  }
  beadsDispatchExtension(pi as any)
  return { pi, registered, tools, execCalls, cwd, branch, head, beadId }
}

describe('visible child argv', () => {
  it('fail-closes without --append-system-prompt or --tools', () => {
    expect(validateVisibleChildArgv(['pi', '--no-session'])).toEqual(expect.arrayContaining(['missing --append-system-prompt', 'missing --tools']))
  })

  it('fail-closes when neither --no-session nor --session is present', () => {
    expect(validateVisibleChildArgv(['pi', '--append-system-prompt', 'a.md', '--tools', 'read'])).toEqual(['missing --no-session or throwaway --session dir'])
  })

  it('accepts --no-session mode', () => {
    const argv = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'no-session' }, tools: 'read,bash,edit,write' })
    expect(validateVisibleChildArgv(argv)).toEqual([])
    expect(argv).toContain('--no-session')
    expect(argv).toContain('--tools')
  })

  it('accepts throwaway --session dir', () => {
    const argv = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'session-dir', dir: '/tmp/sess' } })
    expect(validateVisibleChildArgv(argv)).toEqual([])
    expect(argv).toContain('--session')
    expect(argv).toContain('/tmp/sess')
  })

  it('passes agent tools through and defaults when omitted', () => {
    const custom = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'no-session' }, tools: 'read,bash' })
    expect(custom[custom.indexOf('--tools') + 1]).toBe('read,bash')
    const def = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'no-session' } })
    expect(def[def.indexOf('--tools') + 1]).toBe('read,bash,edit,write')
  })
})

describe('N dummy registry prune', () => {
  it('tombstones dead panes and keeps live ones', () => {
    const registry = {
      entries: [
        { taskId: 'a', beadId: 'b1', pane: 'surface:1', worktree: '/wt1', role: 'test-supervisor', model: 'x', taskFile: 't1', resultFile: 'r1', digestFile: 'd1', promptFile: 'p1', status: 'spawned' as const, createdAt: 't' },
        { taskId: 'b', beadId: 'b2', pane: 'surface:2', worktree: '/wt2', role: 'vue-supervisor', model: 'y', taskFile: 't2', resultFile: 'r2', digestFile: 'd2', promptFile: 'p2', status: 'spawned' as const, createdAt: 't' },
        { taskId: 'c', beadId: 'b3', pane: 'surface:3', worktree: '/wt3', role: 'tauri-supervisor', model: 'z', taskFile: 't3', resultFile: 'r3', digestFile: 'd3', promptFile: 'p3', status: 'spawned' as const, createdAt: 't' },
      ],
    }
    const pruned = pruneRegistry(registry, new Set(['surface:1', 'surface:3']))
    expect(pruned.entries.map((entry) => entry.status)).toEqual(['spawned', 'tombstone', 'spawned'])
  })
})

describe('orch root isolation', () => {
  it('uses ORCH_ROOT / HOME override and not the Haasbot tree', () => {
    expect(orchRoot({ ORCH_ROOT: '/tmp/orch-test' })).toBe('/tmp/orch-test')
    expect(orchRoot({ HOME: '/tmp/home-test' })).toBe(path.join('/tmp/home-test', '.pi', 'orchestrator'))
    expect(nsDir('ws-1', { ORCH_ROOT: '/tmp/orch-test' })).toBe(path.join('/tmp/orch-test', 'ns', 'ws-1'))
    expect(orchRoot({ ORCH_ROOT: '/tmp/orch-test' })).not.toContain('Haasbot')
  })
})

describe('dispatch_supervisor transport=cmux', () => {
  let tmp: string
  const prevOrch = process.env.ORCH_ROOT
  const prevHome = process.env.HOME

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hyjy-cmux-'))
    process.env.ORCH_ROOT = tmp
    process.env.HOME = tmp
    setCmuxAdapterForTests(null)
  })

  afterEach(() => {
    setCmuxAdapterForTests(null)
    if (prevOrch === undefined) delete process.env.ORCH_ROOT
    else process.env.ORCH_ROOT = prevOrch
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('dryRun+cmux returns spawn-ack, no pane, no DISPATCH comments', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { registered, cwd, branch, beadId, head } = makePi({ execCalls })
    const result = await registered.execute('call-1', { beadId, dryRun: true, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.status).toBe('spawned')
    expect(result.details.transport).toBe('cmux')
    expect(result.details.pane).toBe('')
    expect(result.details.endCommit).toBeUndefined()
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments).toEqual([])
    expect(fs.existsSync(path.join(tmp, 'ns'))).toBe(false)
  })

  it('omitted transport stays headless and writes DISPATCH on dryRun', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { registered, cwd, branch, beadId, head } = makePi({ execCalls })
    const result = await registered.execute('call-1', { beadId, dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.transport).toBeUndefined()
    expect(result.details.status).not.toBe('spawned')
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments.length).toBeGreaterThan(0)
    const headlessComment = comments[0]
    expect(headlessComment).toBeDefined()
    expect(headlessComment!.args.join(' ')).toContain('DISPATCH (')
    expect(headlessComment!.args.join(' ')).not.toContain('DISPATCH RESULT')
  })

  it('requestSupervisorDispatch strips transport=cmux to headless', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { pi, cwd, branch, beadId, head } = makePi({ execCalls })
    const result = await requestSupervisorDispatch(pi, { beadId, dryRun: true, transport: 'cmux', agent: 'test-supervisor' }, workflowCtx(cwd, beadId, branch, head))
    expect(result.ok).toBe(true)
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments.length).toBeGreaterThan(0)
    const strippedComment = comments[0]
    expect(strippedComment).toBeDefined()
    expect(strippedComment!.args.join(' ')).toContain('DISPATCH (')
  })

  it('mocked adapter persists isolation files and does not unlink them on spawn-ack', async () => {
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-live' } },
      async newSplit() { return { surface: 'surface:9' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
    })
    const { registered, cwd, branch, beadId, head, execCalls } = makePi({ execCalls: [] })
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.status).toBe('spawned')
    expect(result.details.pane).toBe('surface:9')
    expect(closed).toEqual([])
    const taskFile = result.details.taskFile
    expect(taskFile).toBeDefined()
    const prompt = taskFile!.replace('/tasks/', '/prompts/').replace(/\.md$/, '.md')
    expect(fs.existsSync(taskFile!)).toBe(true)
    expect(fs.existsSync(prompt)).toBe(true)
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments.length).toBeGreaterThan(0)
    expect(comments[0]?.args.join(' ')).toContain('DISPATCH (')
    expect(comments[0]?.args.join(' ')).not.toContain('DISPATCH RESULT')
    const registry = loadRegistry(path.join(tmp, 'ns', 'ws-live', 'dispatch-registry.json'))
    expect(registry.entries).toHaveLength(1)
    const liveEntry = registry.entries[0]
    expect(liveEntry).toBeDefined()
    expect(liveEntry!.status).toBe('spawned')
    expect(fs.existsSync(liveEntry!.promptFile)).toBe(true)
  })

  it('kills pane when send fails before registry', async () => {
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-fail' } },
      async newSplit() { return { surface: 'surface:8' } },
      async send() { throw new Error('send failed') },
      async closeSurface(surface) { closed.push(surface) },
    })
    const { registered, cwd, branch, beadId, head } = makePi({})
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details?.error || result.content[0].text).toMatch(/send failed/)
    expect(closed).toEqual(['surface:8'])
    expect(fs.existsSync(path.join(tmp, 'ns', 'ws-fail', 'dispatch-registry.json'))).toBe(false)
  })

  it('duplicate spawn of live bead is BLOCKED', async () => {
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-dup' } },
      async newSplit() { return { surface: 'surface:1' } },
      async send() {},
      async closeSurface() {},
    })
    const { registered, cwd, branch, beadId, head } = makePi({})
    const ctx = workflowCtx(cwd, beadId, branch, head)
    const first = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, ctx)
    expect(first.details.status).toBe('spawned')
    const second = await registered.execute('call-2', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, ctx)
    expect(second.content[0].text).toMatch(/повторный spawn|BLOCKED/)
  })

  it('live typed cmux without adapter is BLOCKED when identify fails', async () => {
    const { registered, cwd, branch, beadId, head } = makePi({})
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.content[0].text).toMatch(/BLOCKED|identify/)
  })
})

describe('reviewer/docs reject transport', () => {
  it('dispatch_reviewer execute rejects transport', async () => {
    const { tools, cwd, branch } = makePi({ toolName: 'dispatch_reviewer', beadId: 'bead-r' })
    const result = await tools.dispatch_reviewer.execute('call-1', { beadId: 'bead-r', transport: 'cmux' }, undefined, undefined, workflowCtx(cwd, 'bead-r', branch, 'abc1234'))
    expect(result.content[0].text).toMatch(/does not accept transport/)
  })

  it('dispatch_docs_agent execute rejects transport', async () => {
    const { tools, cwd, branch } = makePi({ toolName: 'dispatch_docs_agent', beadId: 'bead-d' })
    const result = await tools.dispatch_docs_agent.execute('call-1', { beadId: 'bead-d', transport: 'cmux' }, undefined, undefined, workflowCtx(cwd, 'bead-d', branch, 'abc1234'))
    expect(result.content[0].text).toMatch(/does not accept transport/)
  })

  it('schemas: supervisor has transport, reviewer/docs do not', () => {
    const { tools } = makePi({})
    expect(tools.dispatch_supervisor.parameters.properties.transport.enum).toEqual(['headless', 'cmux'])
    expect(tools.dispatch_reviewer.parameters.properties.transport).toBeUndefined()
    expect(tools.dispatch_docs_agent.parameters.properties.transport).toBeUndefined()
    expect(tools.dispatch_reviewer.parameters.additionalProperties).toBe(false)
  })
})

describe('persistIsolationFiles', () => {
  it('writes prompt and task under ns and saveRegistry roundtrips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyjy-ns-'))
    try {
      const files = persistIsolationFiles(dir, 't1', '# prompt', '# task')
      expect(fs.readFileSync(files.promptFile, 'utf8')).toBe('# prompt')
      expect(fs.readFileSync(files.taskFile, 'utf8')).toBe('# task')
      saveRegistry(path.join(dir, 'dispatch-registry.json'), { entries: [] })
      expect(loadRegistry(path.join(dir, 'dispatch-registry.json')).entries).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

const completeArtifact = `Status: DONE
Artifact status: complete
Verification: pnpm test exit code 0 passed
Commit: abcdef1234567`

describe('complete_visible_dispatch', () => {
  let tmp: string
  const prevOrch = process.env.ORCH_ROOT

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfh7-complete-'))
    process.env.ORCH_ROOT = tmp
  })

  afterEach(() => {
    if (prevOrch === undefined) delete process.env.ORCH_ROOT
    else process.env.ORCH_ROOT = prevOrch
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function seed(entry: Record<string, string>) {
    const file = path.join(tmp, 'ns', 'ws-c', 'dispatch-registry.json')
    saveRegistry(file, {
      entries: [{
        taskId: 'task-1',
        beadId: 'bead-a',
        pane: 'surface:1',
        worktree: tmp,
        role: 'test-supervisor',
        model: '',
        taskFile: path.join(tmp, 't.md'),
        resultFile: path.join(tmp, 'r.md'),
        digestFile: path.join(tmp, 'd.digest'),
        promptFile: path.join(tmp, 'p.md'),
        status: 'spawned',
        submitStatus: 'none',
        startCommit: 'aaa1111',
        createdAt: 't',
        ...entry,
      }],
    })
  }

  it('ping with digest sends to review and later ping is noop', async () => {
    seed({})
    fs.writeFileSync(path.join(tmp, 'd.digest'), completeArtifact)
    const { pi } = makePi({ head: 'bbb2222' })
    const first = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(first.status).toBe('submitted')
    expect(findRegistryByTaskId('task-1')?.entry.submitStatus).toBe('submitted')
    const second = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(second.status).toBe('noop')
  })

  it('ping without digest stays incomplete', async () => {
    seed({})
    const { pi } = makePi({ head: 'bbb2222' })
    const first = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(first.status).toBe('incomplete')
  })

  it('registers complete_visible_dispatch tool', () => {
    const { tools } = makePi({ toolName: 'complete_visible_dispatch' })
    expect(tools.complete_visible_dispatch).toBeDefined()
  })
})
