import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import beadsDispatchExtension, {
  beadSuffixFromId,
  buildCmuxRenameArgv,
  buildVisibleChildArgv,
  buildVisibleChildSpawnPayload,
  closeVisibleDispatch,
  completeVisibleDispatch,
  findRegistryByTaskId,
  followupVisibleDispatch,
  followupPayloadLooksLikeSpawnArgv,
  loadRegistry,
  nsDir,
  orchRoot,
  ORCHESTRATOR_TAB_TITLE,
  persistIsolationFiles,
  posixQuote,
  pruneRegistry,
  visibleChildTabTitle,
  visibleCmuxSpawnFailReason,
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

function workflowCtx(cwd: string, beadId: string, branch: string, startCommit: string, worktreePath = cwd) {
  return {
    cwd,
    sessionManager: {
      getEntries: () => [{ type: 'custom', customType: 'workflow-state', data: { activeBead: beadId, branch, worktreePath, startCommit, sessionKey: 'session:test' } }],
    },
  }
}

function makePi(opts: { toolName?: string; execCalls?: Array<{ command: string; args: string[] }>; cwd?: string; branch?: string; head?: string; beadId?: string; status?: string; cmux?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }> }) {
  const toolName = opts.toolName ?? 'dispatch_supervisor'
  const execCalls = opts.execCalls ?? []
  const emitted: Array<{ name: string; event: Record<string, unknown> }> = []
  const cwd = opts.cwd ?? process.cwd()
  const branch = opts.branch ?? (currentBranch(cwd) === 'main' || currentBranch(cwd) === 'master' ? 'task/cmux-fixture' : currentBranch(cwd))
  const head = opts.head ?? 'abc1234'
  const beadId = opts.beadId ?? 'bead-a'
  const status = opts.status ?? 'in_progress'
  let registered: any
  const tools: Record<string, any> = {}
  const pi = {
    events: { emit(name: string, event: Record<string, unknown>) { emitted.push({ name, event }) } },
    registerTool(tool: any) {
      tools[tool.name] = tool
      if (tool.name === toolName) registered = tool
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: beadId, status, labels: ['dx'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
      if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
      if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : `${head}\n`, stderr: '', code: 0 }
      if (command === 'cmux' && opts.cmux) return opts.cmux(args)
      return { stdout: '', stderr: '', code: 0 }
    },
  }
  beadsDispatchExtension(pi as any)
  return { pi, registered, tools, execCalls, emitted, cwd, branch, head, beadId }
}

describe('visible cmux tab titles', () => {
  it('derives bead suffix and rename argv without focusing the pane', () => {
    expect(beadSuffixFromId('')).toBe('')
    expect(beadSuffixFromId('fo5d')).toBe('fo5d')
    expect(beadSuffixFromId('beads-task-issue-tracker-fo5d')).toBe('fo5d')
    expect(visibleChildTabTitle('test-supervisor', 'beads-task-issue-tracker-fo5d')).toBe('test-supervisor · fo5d')
    expect(ORCHESTRATOR_TAB_TITLE).toBe('оркестратор')
    expect(buildCmuxRenameArgv('surface:x', 't')).toEqual([
      'tab-action', '--action', 'rename', '--surface', 'surface:x', '--title', 't', '--focus', 'false',
    ])
  })
})

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

  it('POSIX-quotes cd worktree && argv including spaces', () => {
    const argv = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: '/tmp/task file.md', session: { kind: 'no-session' }, tools: 'read,bash,edit,write' })
    const payload = buildVisibleChildSpawnPayload('/tmp/task worktree', argv)
    expect(payload.startsWith(`cd ${posixQuote('/tmp/task worktree')} && `)).toBe(true)
    expect(payload).toContain("pi")
    expect(payload).toContain('--no-session')
    expect(payload).not.toMatch(/^pi /)
  })

  it('fail-closes protected branch or payload without worktree', () => {
    expect(visibleCmuxSpawnFailReason({ branch: 'main', worktreePath: '/tmp/task', payload: 'cd /tmp/task && pi\n' })).toMatch(/protected branch/)
    expect(visibleCmuxSpawnFailReason({ branch: 'master', worktreePath: '/tmp/task', payload: 'cd /tmp/task && pi\n' })).toMatch(/protected branch/)
    expect(visibleCmuxSpawnFailReason({ branch: 'fix/x', worktreePath: '', payload: 'pi --no-session\n' })).toMatch(/without task worktree/)
    expect(visibleCmuxSpawnFailReason({ branch: 'fix/x', worktreePath: '/tmp/task', payload: 'pi --no-session\n' })).toMatch(/without task worktree/)
    expect(visibleCmuxSpawnFailReason({ branch: 'fix/x', worktreePath: '/tmp/task', payload: 'cd /tmp/task && pi --no-session\n' })).toBeUndefined()
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

  it('requestSupervisorDispatch passes transport=cmux', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { pi, cwd, branch, beadId, head } = makePi({ execCalls })
    const result = await requestSupervisorDispatch(pi, { beadId, dryRun: true, transport: 'cmux', agent: 'test-supervisor' }, workflowCtx(cwd, beadId, branch, head))
    expect(result.ok).toBe(true)
    expect((result.details as { status?: string; transport?: string }).status).toBe('spawned')
    expect((result.details as { transport?: string }).transport).toBe('cmux')
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments).toEqual([])
  })

  it('mocked adapter persists isolation files and does not unlink them on spawn-ack', async () => {
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-live' } },
      async newSplit() { return { surface: 'surface:9' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
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

  it('visible task body quotes ping.sh and does not use bare Ping taskId=', async () => {
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-ping' } },
      async newSplit() { return { surface: 'surface:11' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
    })
    const { registered, cwd, branch, beadId, head } = makePi({ execCalls: [] })
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.status).toBe('spawned')
    const body = fs.readFileSync(result.details.taskFile!, 'utf8')
    const pingSh = path.join(cwd, '.pi/orchestrator/ping.sh')
    expect(body).toContain(`bash '${pingSh}'`)
    expect(body).toMatch(/DIGEST_FILE='[^']+' bash '/)
    expect(body).not.toMatch(/Ping taskId=/)
    expect(body).toContain('KIND=error')
    expect(body).toContain('Child stdout is not delivery')
    const agentNamePrefix = "AGENT_NAME='test-supervisor' DIGEST_FILE="
    expect(body.split(agentNamePrefix)).toHaveLength(3)
    expect(body).toMatch(/AGENT_NAME='test-supervisor' DIGEST_FILE='[^']+' bash '/)
    expect(body).not.toContain("AGENT_NAME='agent'")
  })

  it('pins ping.sh unset AGENT_NAME warning and last-resort fallback', () => {
    const pingSh = fs.readFileSync(path.join(process.cwd(), '.pi/orchestrator/ping.sh'), 'utf8')
    expect(pingSh).toContain('if [ -z "${AGENT_NAME:-}" ]')
    expect(pingSh).toContain('echo "AGENT_NAME unset; falling back to agent" >&2')
    expect(pingSh).toContain('NAME="${AGENT_NAME:-agent}"')
  })

  it('pins always-on agents: ping.sh required and chat report is not delivery', () => {
    const agents = [
      'test-supervisor.md',
      'vue-supervisor.md',
      'tauri-supervisor.md',
      'code-reviewer.md',
    ]
    for (const name of agents) {
      const text = fs.readFileSync(path.join(process.cwd(), '.pi/agents', name), 'utf8')
      expect(text, name).toContain('ping.sh')
      expect(text, name).toContain('чат-отчёт не заменяет')
      expect(text, name).toContain('AGENT_NAME=')
      expect(text, name).toContain('DIGEST_FILE=')
    }
  })

  it('pins WRAPPER BOUNDARY does not cancel visible ping.sh', () => {
    const src = fs.readFileSync(path.join(process.cwd(), '.pi/extensions/beads-dispatch/index.ts'), 'utf8')
    const start = src.indexOf('WRAPPER WORKFLOW BOUNDARY:')
    const boundary = src.slice(start, src.indexOf('`;', start))
    expect(boundary).toContain('ping.sh')
    expect(boundary).toContain('Chat completion report is not delivery')
    expect(boundary).not.toMatch(/return the SUPERVISOR ARTIFACT; the wrapper\/orchestrator owns review-transition routing\.`/)
  })

  it('pins skill child ping command order AGENT_NAME then DIGEST_FILE then bash ping.sh', () => {
    const skill = fs.readFileSync(path.join(process.cwd(), '.pi/skills/dispatch-supervisor/SKILL.md'), 'utf8')
    const pingSentence = skill.split('\n').find((line) => line.includes('Child ping:') && line.includes('ping.sh'))
    expect(pingSentence).toBeDefined()
    const agentIdx = pingSentence!.indexOf('AGENT_NAME=')
    const digestIdx = pingSentence!.indexOf('DIGEST_FILE=')
    const bashIdx = pingSentence!.indexOf('bash')
    const pingIdx = pingSentence!.indexOf('ping.sh')
    expect(agentIdx).toBeGreaterThanOrEqual(0)
    expect(digestIdx).toBeGreaterThan(agentIdx)
    expect(bashIdx).toBeGreaterThan(digestIdx)
    expect(pingIdx).toBeGreaterThan(bashIdx)
  })

  it('ping.sh fail-closes send without || true and keeps newline in the same send', () => {
    const pingSh = fs.readFileSync(path.join(process.cwd(), '.pi/orchestrator/ping.sh'), 'utf8')
    expect(pingSh).toMatch(/send --surface "\$ORCH" "\$\{MSG\}\\n"/)
    expect(pingSh).not.toMatch(/send --surface "\$ORCH" "\$\{MSG\}\\n" \|\| true/)
    expect(pingSh).toMatch(/notify[\s\S]*\|\| true/)
    expect(pingSh).toMatch(/trigger-flash[\s\S]*\|\| true/)
  })

  it('ping.sh fail-closes nonempty DIGEST_FILE missing/empty before send, not as send-fail', () => {
    const pingSh = fs.readFileSync(path.join(process.cwd(), '.pi/orchestrator/ping.sh'), 'utf8')
    const failCloseComment = '# Fail-close: nonempty DIGEST_FILE missing/empty is not a send-fail; retry send will not create digest.'
    const ifWrapper = 'if [ -n "${DIGEST_FILE:-}" ] && { [ ! -f "$DIGEST_FILE" ] || [ ! -s "$DIGEST_FILE" ]; }; then'
    const echoLine = 'echo "✗ ping: DIGEST_FILE missing/empty → $DIGEST_FILE" >&2'
    const nameIdx = pingSh.indexOf('NAME="${AGENT_NAME:-agent}"')
    const commentIdx = pingSh.indexOf(failCloseComment)
    const ifIdx = pingSh.indexOf(ifWrapper)
    const echoIdx = pingSh.indexOf(echoLine)
    const exitIdx = pingSh.indexOf('  exit 1', ifIdx)
    const digestHintIdx = pingSh.indexOf('DIGEST_HINT=')
    const sendIdx = pingSh.indexOf('"$CMUX" send --surface "$ORCH"')
    expect(nameIdx).toBeGreaterThan(-1)
    expect(commentIdx).toBeGreaterThan(nameIdx)
    expect(ifIdx).toBeGreaterThan(commentIdx)
    expect(echoIdx).toBeGreaterThan(ifIdx)
    expect(exitIdx).toBeGreaterThan(echoIdx)
    expect(digestHintIdx).toBeGreaterThan(exitIdx)
    expect(sendIdx).toBeGreaterThan(digestHintIdx)
  })

  it('kills pane when send fails before registry', async () => {
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-fail' } },
      async newSplit() { return { surface: 'surface:8' } },
      async send() { throw new Error('send failed') },
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
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
      async readScreen() { return '' },
    })
    const { registered, cwd, branch, beadId, head } = makePi({})
    const ctx = workflowCtx(cwd, beadId, branch, head)
    const first = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, ctx)
    expect(first.details.status).toBe('spawned')
    const second = await registered.execute('call-2', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, ctx)
    expect(second.content[0].text).toMatch(/followup_visible_dispatch\(\{ beadId \}\)/)
    expect(second.content[0].text).toMatch(/BLOCKED/)
  })

  it('renames child and orchestrator tabs after visible spawn', async () => {
    const renames: Array<{ surface: string; title: string }> = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-rename' } },
      callerSurface() { return 'surface:orch' },
      async newSplit() { return { surface: 'surface:child' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
      async renameSurface(surface, title) { renames.push({ surface, title }) },
    })
    const beadId = 'beads-task-issue-tracker-fo5d'
    const { registered, cwd, branch, head } = makePi({ beadId })
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.status).toBe('spawned')
    expect(renames).toEqual([
      { surface: 'surface:child', title: 'test-supervisor · fo5d' },
      { surface: 'surface:orch', title: ORCHESTRATOR_TAB_TITLE },
    ])
    expect(visibleChildTabTitle('test-supervisor', beadId)).toBe('test-supervisor · fo5d')
    expect(beadSuffixFromId(beadId)).toBe('fo5d')
  })

  it('live adapter rename uses tab-action argv with --focus false', async () => {
    setCmuxAdapterForTests(null)
    const cmuxCalls: string[][] = []
    const beadId = 'beads-task-issue-tracker-fo5d'
    const { registered, cwd, branch, head } = makePi({
      beadId,
      cmux: async (args) => {
        cmuxCalls.push(args)
        if (args[0] === 'identify') {
          return { stdout: JSON.stringify({ caller: { workspace_ref: 'ws-live-rename', surface_ref: 'surface:orch' } }), stderr: '', code: 0 }
        }
        if (args[0] === 'new-split') return { stdout: 'surface:child\n', stderr: '', code: 0 }
        if (args[0] === 'send') return { stdout: '', stderr: '', code: 0 }
        if (args[0] === 'tab-action') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    })
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.status).toBe('spawned')
    const renames = cmuxCalls.filter((args) => args[0] === 'tab-action')
    expect(renames).toContainEqual(buildCmuxRenameArgv('surface:child', 'test-supervisor · fo5d'))
    expect(renames).toContainEqual(buildCmuxRenameArgv('surface:orch', ORCHESTRATOR_TAB_TITLE))
    expect(buildCmuxRenameArgv('surface:x', 't')).toEqual([
      'tab-action', '--action', 'rename', '--surface', 'surface:x', '--title', 't', '--focus', 'false',
    ])
  })

  it('live adapter new-split argv includes --focus false', async () => {
    setCmuxAdapterForTests(null)
    const cmuxCalls: string[][] = []
    const beadId = 'beads-task-issue-tracker-ok60'
    const { registered, cwd, branch, head } = makePi({
      beadId,
      cmux: async (args) => {
        cmuxCalls.push(args)
        if (args[0] === 'identify') {
          return {
            stdout: JSON.stringify({
              caller: { workspace_ref: 'ws-live-new-split-focus', surface_ref: 'surface:orch' },
            }),
            stderr: '',
            code: 0,
          }
        }
        if (args[0] === 'new-split') return { stdout: 'surface:child\n', stderr: '', code: 0 }
        if (args[0] === 'send') return { stdout: '', stderr: '', code: 0 }
        if (args[0] === 'tab-action') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    })
    const result = await registered.execute(
      'call-1',
      { beadId, transport: 'cmux', agent: 'test-supervisor' },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head),
    )
    expect(result.details.status).toBe('spawned')
    const splits = cmuxCalls.filter((args) => args[0] === 'new-split')
    expect(splits).toHaveLength(1)
    expect(splits[0]).toEqual([
      'new-split', 'right', '--surface', 'surface:orch', '--focus', 'false',
    ])
    expect(cmuxCalls.some((args) => args[0] === 'focus-pane')).toBe(false)
  })

  it('live typed cmux without adapter is BLOCKED when identify fails', async () => {
    const { registered, cwd, branch, beadId, head } = makePi({})
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.content[0].text).toMatch(/BLOCKED|identify/)
  })

  it('sends quoted cd task-worktree && pi when orchestrator cwd is protected main', async () => {
    const sent: string[] = []
    const taskWt = process.cwd()
    const orchMain = '/Users/maksimposudevskiy/Projects/beads-task-issue-tracker'
    const taskBranch = currentBranch(taskWt)
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-main-vs-wt' } },
      async newSplit() { return { surface: 'surface:191' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() { return '' },
    })
    const { registered, beadId, head, emitted } = makePi({ cwd: taskWt, branch: taskBranch })
    const result = await registered.execute(
      'call-1',
      { beadId, transport: 'cmux', agent: 'test-supervisor' },
      undefined,
      undefined,
      workflowCtx(orchMain, beadId, taskBranch, head, taskWt),
    )
    expect(result.details?.error || result.details.status).toBe('spawned')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(`cd ${posixQuote(taskWt)} && `)
    expect(sent[0]).toContain('--no-session')
    expect(sent[0]).toContain('--tools')
    expect(sent[0]).toContain('read,bash,edit,write')
    expect(sent[0]).not.toMatch(/^pi /)
    expect(sent[0]).not.toContain(orchMain)
    const registry = loadRegistry(path.join(tmp, 'ns', 'ws-main-vs-wt', 'dispatch-registry.json'))
    expect(registry.entries[0]?.worktree).toBe(taskWt)
    const bind = emitted.find((item) => item.name === 'workflow-state:update')
    expect(bind?.event).toMatchObject({ activeBead: beadId, state: 'implementing', sessionMode: 'implementing', worktreePath: taskWt })
    expect(bind?.event.state).not.toBe('idle')
    expect(bind?.event.activeBead).not.toBeUndefined()
  })

  it('fail-closes protected spawn target and payload without worktree', () => {
    expect(visibleCmuxSpawnFailReason({ branch: 'main', worktreePath: process.cwd(), payload: `cd ${process.cwd()} && pi\n` })).toMatch(/protected branch/)
    expect(visibleCmuxSpawnFailReason({ branch: 'fix/x', worktreePath: process.cwd(), payload: 'pi --no-session\n' })).toMatch(/without task worktree/)
  })
})

describe('reviewer/docs transport', () => {
  it('dispatch_docs_agent execute rejects transport', async () => {
    const { tools, cwd, branch } = makePi({ toolName: 'dispatch_docs_agent', beadId: 'bead-d' })
    const result = await tools.dispatch_docs_agent.execute('call-1', { beadId: 'bead-d', transport: 'cmux' }, undefined, undefined, workflowCtx(cwd, 'bead-d', branch, 'abc1234'))
    expect(result.content[0].text).toMatch(/does not accept transport/)
  })

  it('schemas: supervisor and reviewer have transport, docs does not', () => {
    const { tools } = makePi({})
    expect(tools.dispatch_supervisor.parameters.properties.transport.enum).toEqual(['headless', 'cmux'])
    expect(tools.dispatch_reviewer.parameters.properties.transport.enum).toEqual(['headless', 'cmux'])
    expect(tools.followup_visible_dispatch).toBeDefined()
    expect(tools.followup_visible_dispatch.description).toMatch(/Единственный typed hop/)
    expect(tools.dispatch_docs_agent.parameters.properties.transport).toBeUndefined()
    expect(tools.dispatch_reviewer.parameters.additionalProperties).toBe(false)
  })
})

describe('dispatch_reviewer transport=cmux', () => {
  let tmp: string
  const prevOrch = process.env.ORCH_ROOT
  const prevHome = process.env.HOME

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esg3-reviewer-'))
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

  function reviewerPi(extra: { head?: string; execCalls?: Array<{ command: string; args: string[] }> } = {}) {
    return makePi({
      toolName: 'dispatch_reviewer',
      beadId: 'bead-r',
      status: 'inreview',
      head: extra.head,
      execCalls: extra.execCalls,
    })
  }

  it('omitted transport stays headless', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { tools, cwd, branch, beadId, head } = reviewerPi({ execCalls })
    const result = await tools.dispatch_reviewer.execute('call-1', { beadId, dryRun: true }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.transport).toBeUndefined()
    expect(result.details.status).not.toBe('spawned')
  })

  it('dryRun+cmux returns spawn-ack, no pane', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { tools, cwd, branch, beadId, head } = reviewerPi({ execCalls })
    const result = await tools.dispatch_reviewer.execute('call-1', { beadId, dryRun: true, transport: 'cmux' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.status).toBe('spawned')
    expect(result.details.transport).toBe('cmux')
    expect(result.details.pane).toBe('')
    expect(execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')).toEqual([])
  })

  it('no cmux is BLOCKED, not silent headless', async () => {
    const { tools, cwd, branch, beadId, head } = reviewerPi()
    const result = await tools.dispatch_reviewer.execute('call-1', { beadId, transport: 'cmux' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.content[0].text).toMatch(/BLOCKED|identify/)
    expect(result.details.status).not.toBe('spawned')
    expect(result.content[0].text).not.toMatch(/does not accept transport/)
  })

  it('inreview HEAD≠startCommit uses recorded startCommit', async () => {
    const recorded = 'aaa1111'
    const head = 'bbb2222'
    const execCalls: Array<{ command: string; args: string[] }> = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-rev-start' } },
      async newSplit() { return { surface: 'surface:r1' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
    })
    const { tools, cwd, branch, beadId, emitted } = reviewerPi({ head, execCalls })
    const result = await tools.dispatch_reviewer.execute('call-1', { beadId, transport: 'cmux' }, undefined, undefined, workflowCtx(cwd, beadId, branch, recorded))
    expect(result.details.status).toBe('spawned')
    expect(result.details.startCommit).toBe(recorded)
    expect(result.details.startCommit).not.toBe(head)
    const dispatchComment = execCalls.find((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(dispatchComment?.args.join(' ')).toContain(`START_COMMIT: ${recorded}`)
    expect(dispatchComment?.args.join(' ')).not.toContain(`START_COMMIT: ${head}`)
    const body = fs.readFileSync(result.details.taskFile!, 'utf8')
    expect(body).toContain(`START_COMMIT: ${recorded}`)
    expect(body).toContain('CODE REVIEW verdict')
    expect(body).not.toContain('Write SUPERVISOR ARTIFACT')
    expect(body).toContain("AGENT_NAME='code-reviewer'")
    expect(result.details.registryKey).toMatch(/code-reviewer$/)
    const bind = emitted.find((item) => item.name === 'workflow-state:update')
    expect(bind?.event.state).toBe('reviewing')
    expect(bind?.event.sessionMode).toBe('reviewing')
    expect(bind?.event.state).not.toBe('implementing')
  })

  it('live supervisor + reviewer spawn two taskIds', async () => {
    let splits = 0
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-two' } },
      async newSplit() {
        splits += 1
        return { surface: `surface:${splits}` }
      },
      async send() {},
      async readScreen() { return '' },
      async closeSurface() {},
    })
    const { tools, cwd, branch, beadId, head } = makePi({ beadId: 'bead-two', status: 'in_progress' })
    const supervisor = await tools.dispatch_supervisor.execute('s1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(supervisor.details.status).toBe('spawned')
    const reviewerPiInst = makePi({ toolName: 'dispatch_reviewer', beadId, status: 'inreview', head, cwd, branch })
    const reviewer = await reviewerPiInst.tools.dispatch_reviewer.execute('r1', { beadId, transport: 'cmux' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(reviewer.details.status).toBe('spawned')
    expect(reviewer.details.registryKey).not.toBe(supervisor.details.registryKey)
    const registry = loadRegistry(path.join(tmp, 'ns', 'ws-two', 'dispatch-registry.json'))
    expect(registry.entries).toHaveLength(2)
    expect(registry.entries.map((entry) => entry.taskId).sort()).toEqual([supervisor.details.registryKey, reviewer.details.registryKey].sort())
    expect(registry.entries.map((entry) => entry.role).sort()).toEqual(['code-reviewer', 'test-supervisor'].sort())
  })

  it('second live code-reviewer spawn is BLOCKED', async () => {
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-dup-rev' } },
      async newSplit() { return { surface: 'surface:dup' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
    })
    const { tools, cwd, branch, beadId, head } = reviewerPi()
    const ctx = workflowCtx(cwd, beadId, branch, head)
    const first = await tools.dispatch_reviewer.execute('r1', { beadId, transport: 'cmux' }, undefined, undefined, ctx)
    expect(first.details.status).toBe('spawned')
    const second = await tools.dispatch_reviewer.execute('r2', { beadId, transport: 'cmux' }, undefined, undefined, ctx)
    expect(second.content[0].text).toMatch(/BLOCKED/)
    expect(second.content[0].text).toMatch(/followup_visible_dispatch\(\{ beadId, role: "code-reviewer" \}\)/)
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

  it('retries incomplete ping and no-ops after submit', async () => {
    seed({})
    fs.writeFileSync(path.join(tmp, 'd.digest'), 'still working')
    const { pi, emitted } = makePi({ head: 'aaa1111' })
    const first = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(first.status).toBe('result-only')
    expect(findRegistryByTaskId('task-1')?.entry.submitStatus).toBe('result-only')
    expect(emitted.find((item) => item.name === 'workflow-state:update')?.event).toMatchObject({
      activeBead: 'bead-a',
      state: 'implementing',
      sessionMode: 'implementing',
      worktreePath: tmp,
    })
    fs.writeFileSync(path.join(tmp, 'r.md'), completeArtifact)
    const { pi: pi2, emitted: emitted2 } = makePi({ head: 'bbb2222' })
    const second = await completeVisibleDispatch(pi2 as any, { taskId: 'task-1' })
    expect(second.status).toBe('submitted')
    expect(emitted2.find((item) => item.name === 'workflow-state:update')?.event).toMatchObject({
      activeBead: 'bead-a',
      state: 'inreview',
      sessionMode: 'inreview',
      worktreePath: tmp,
    })
    const third = await completeVisibleDispatch(pi2 as any, { taskId: 'task-1' })
    expect(third.status).toBe('noop')
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

  it('code-reviewer APPROVED records CODE REVIEW verdict without submit-for-review', async () => {
    seed({ role: 'code-reviewer' })
    fs.writeFileSync(path.join(tmp, 'd.digest'), 'CODE REVIEW: APPROVED')
    fs.writeFileSync(path.join(tmp, 'r.md'), 'CODE REVIEW: APPROVED\nLooks good')
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { pi, emitted } = makePi({ head: 'bbb2222', execCalls })
    const first = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(first.status).toBe('verdict')
    expect(first.text).toContain('CODE REVIEW: APPROVED')
    expect(findRegistryByTaskId('task-1')?.entry.submitStatus).toBe('verdict')
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments.some((call) => call.args.join(' ').includes('CODE REVIEW: APPROVED'))).toBe(true)
    expect(comments.some((call) => call.args.join(' ').includes('WORKFLOW SUBMIT FOR REVIEW'))).toBe(false)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update' && call.args.includes('inreview'))).toBe(false)
    expect(emitted.find((item) => item.name === 'workflow-state:update')?.event.state).toBe('inreview')
    const second = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(second.status).toBe('noop')
    expect(second.text).toMatch(/already recorded verdict/)
  })

  it('code-reviewer NOT APPROVED is verdict and does not spawn supervisor', async () => {
    seed({ role: 'code-reviewer' })
    fs.writeFileSync(path.join(tmp, 'r.md'), 'VERDICT: NOT APPROVED\nFix required')
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { pi } = makePi({ head: 'bbb2222', execCalls })
    const first = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(first.status).toBe('verdict')
    expect(first.text).toContain('CODE REVIEW: NOT APPROVED')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update')).toBe(false)
    expect(execCalls.some((call) => call.args.join(' ').includes('WORKFLOW SUBMIT FOR REVIEW'))).toBe(false)
    expect(execCalls.some((call) => call.command === 'pi')).toBe(false)
  })

  it('code-reviewer without verdict marker is result-only', async () => {
    seed({ role: 'code-reviewer' })
    fs.writeFileSync(path.join(tmp, 'd.digest'), 'still reviewing')
    fs.writeFileSync(path.join(tmp, 'r.md'), `${completeArtifact}\nno verdict here`)
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { pi } = makePi({ head: 'bbb2222', execCalls })
    const first = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(first.status).toBe('result-only')
    expect(findRegistryByTaskId('task-1')?.entry.submitStatus).toBe('result-only')
    expect(execCalls.some((call) => call.args.join(' ').includes('WORKFLOW SUBMIT FOR REVIEW'))).toBe(false)
    expect(execCalls.some((call) => call.args.join(' ').includes('CODE REVIEW:'))).toBe(false)
  })

  it('reviewer complete does not change a live supervisor submitStatus', async () => {
    const file = path.join(tmp, 'ns', 'ws-c', 'dispatch-registry.json')
    saveRegistry(file, {
      entries: [
        {
          taskId: 'task-supervisor',
          beadId: 'bead-a',
          pane: 'surface:s',
          worktree: tmp,
          role: 'test-supervisor',
          model: '',
          taskFile: path.join(tmp, 'st.md'),
          resultFile: path.join(tmp, 'sr.md'),
          digestFile: path.join(tmp, 'sd.digest'),
          promptFile: path.join(tmp, 'sp.md'),
          status: 'spawned',
          submitStatus: 'submitted',
          startCommit: 'aaa1111',
          createdAt: 't',
        },
        {
          taskId: 'task-reviewer',
          beadId: 'bead-a',
          pane: 'surface:r',
          worktree: tmp,
          role: 'code-reviewer',
          model: '',
          taskFile: path.join(tmp, 'rt.md'),
          resultFile: path.join(tmp, 'rr.md'),
          digestFile: path.join(tmp, 'rd.digest'),
          promptFile: path.join(tmp, 'rp.md'),
          status: 'spawned',
          submitStatus: 'none',
          startCommit: 'aaa1111',
          createdAt: 't',
        },
      ],
    })
    fs.writeFileSync(path.join(tmp, 'rr.md'), 'CODE REVIEW: APPROVED')
    const { pi } = makePi({ head: 'bbb2222' })
    const result = await completeVisibleDispatch(pi as any, { taskId: 'task-reviewer' })
    expect(result.status).toBe('verdict')
    expect(findRegistryByTaskId('task-supervisor')?.entry.submitStatus).toBe('submitted')
    expect(findRegistryByTaskId('task-reviewer')?.entry.submitStatus).toBe('verdict')
  })
})

describe('dispatch-supervisor skill frozen A/B', () => {
  const skill = fs.readFileSync(path.join(process.cwd(), '.pi/skills/dispatch-supervisor/SKILL.md'), 'utf8')
  const step6 = skill.slice(skill.indexOf('6. Headless:'), skill.indexOf('7. If the supervisor artifact'))

  it('positive-pins Frozen A/B: both ids, dual next-action, any throw', () => {
    expect(skill).toContain('with id from `taskId=` OR `задача <id>`')
    expect(skill).toContain('Any throw/error from complete_visible_dispatch → one BLOCKED, no retry, no read-screen.')
    expect(skill).toContain('Any throw/error from complete_visible_dispatch → BLOCKED no retry, no read-screen.')
    expect(skill).toContain('incomplete → no review-bead; later ping may complete again')
    expect(skill).toContain('submitted/noop → same-turn review-bead')
    expect(skill).toContain('status=verdict → стоп, не review-bead')
    expect(skill).toContain('do not complete; one BLOCKED: «нет digest/result. Если child ещё работает — записать оба nonempty файла и ping.sh; иначе действие Максима.»')
    expect(skill).toContain('submitted/noop → review-bead. result-only / incomplete artifact → BLOCKED artifact not review-ready')
    expect(skill).toContain('B (on-demand insurance, not primary)')
    expect(skill).toContain('one-shot `poll.sh` insurance hop')
    expect(skill).toContain('Two hang / false-complete / insurance-poll cycles without progress → stop, ask Maxim')
    expect(skill).toContain('8. Continue with `review-bead` automatically after the bead is `inreview`')
    expect(step6).toContain('Headless: wrapper waits for the child, then `DISPATCH RESULT` / maybe submit.')
    expect(step6).toContain('Primary delivery is ping (A); on-demand insurance is one-shot `poll.sh` (B)')
    expect(step6).toContain('STOP/BLOCKED A/B do not call review-bead. Frozen A/B status=verdict → стоп, не review-bead.')
  })

  it('negative-pins old ping/review fragments without pinning bare review-bead', () => {
    expect(skill).not.toContain('Then continue with `review-bead`.')
    expect(skill).not.toContain('Do not call `review_bead` from the ping itself.')
    expect(skill).not.toContain('with `taskId=`, call only `complete_visible_dispatch`')
    expect(step6).not.toContain('Then continue with `review-bead`.')
  })
})

describe('followup_visible_dispatch', () => {
  let tmp: string
  const prevOrch = process.env.ORCH_ROOT
  const prevHome = process.env.HOME

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kp4r-followup-'))
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

  function seed(entry: Record<string, unknown> = {}) {
    const cwd = process.cwd()
    const resultFile = path.join(tmp, 'r.md')
    const digestFile = path.join(tmp, 'd.digest')
    const taskFile = path.join(tmp, 't.md')
    const promptFile = path.join(tmp, 'p.md')
    fs.writeFileSync(taskFile, 'old task')
    fs.writeFileSync(promptFile, '# prompt')
    const file = path.join(tmp, 'ns', 'ws-follow', 'dispatch-registry.json')
    saveRegistry(file, {
      entries: [{
        taskId: 'task-1',
        beadId: 'bead-a',
        pane: 'surface:1',
        worktree: cwd,
        role: 'test-supervisor',
        model: '',
        taskFile,
        resultFile,
        digestFile,
        promptFile,
        status: 'spawned',
        submitStatus: 'none',
        startCommit: 'aaa1111',
        createdAt: 't',
        ...entry,
      }],
    })
    return { file, resultFile, digestFile, taskFile, cwd }
  }

  it('reuses a live code-reviewer pane when role is code-reviewer', async () => {
    seed({ role: 'code-reviewer' })
    const splits: string[] = []
    const sent: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('surface:99'); return { surface: 'surface:99' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() { return 'session reviewing\n$\n' },
    })
    const { pi, cwd, branch, beadId, emitted } = makePi({ beadId: 'bead-a', head: 'bbb2222', status: 'inreview' })
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'code-reviewer', task: 'Re-check the diff' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('sent')
    expect(sent).toEqual(['Re-check the diff\n'])
    expect(splits).toEqual([])
    expect(emitted.find((item) => item.name === 'workflow-state:update')?.event.state).toBe('reviewing')
    expect(emitted.find((item) => item.name === 'workflow-state:update')?.event.state).not.toBe('implementing')
  })

  it('sends task text into a waiting Pi and does not new-split', async () => {
    seed()
    const splits: string[] = []
    const sent: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('surface:99'); return { surface: 'surface:99' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() { return 'session idle\n$\n' },
    })
    const { pi, cwd, branch, beadId, emitted } = makePi({ beadId: 'bead-a', head: 'bbb2222' })
    const result = await followupVisibleDispatch(pi as any, { beadId, task: 'Fix the pane' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('sent')
    expect(sent).toEqual(['Fix the pane\n'])
    expect(splits).toEqual([])
    expect(followupPayloadLooksLikeSpawnArgv(sent[0] ?? '')).toBe(false)
    expect(emitted.find((item) => item.name === 'workflow-state:update')?.event).toMatchObject({
      activeBead: beadId,
      state: 'implementing',
      worktreePath: cwd,
    })
    expect(findRegistryByTaskId('task-1')?.entry.pane).toBe('surface:1')
  })

  it('spawns on shell prompt and does not send the follow-up text', async () => {
    seed()
    const splits: string[] = []
    const sent: string[] = []
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('surface:2'); return { surface: 'surface:2' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return 'user@host ~/proj $\n' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    const result = await followupVisibleDispatch(pi as any, { beadId, task: 'Fix the pane' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('spawned')
    expect(splits).toEqual(['surface:2'])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^cd /)
    expect(sent[0]).toContain('pi')
    expect(sent[0]).not.toBe('Fix the pane\n')
    expect(closed).toEqual(['surface:1'])
    expect(findRegistryByTaskId('task-1')?.entry.pane).toBe('surface:2')
    expect(findRegistryByTaskId('task-1')?.entry.startCommit).toBe('aaa1111')
  })

  it('unlinks submitted artifacts so complete is incomplete until rewrite, then a new DONE is not noop', async () => {
    const files = seed({ submitStatus: 'submitted', startCommit: 'aaa1111' })
    fs.writeFileSync(files.digestFile, 'old digest')
    fs.writeFileSync(files.resultFile, completeArtifact)
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return 'session idle' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a', head: 'bbb2222' })
    await followupVisibleDispatch(pi as any, { beadId, task: 'second hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(fs.existsSync(files.digestFile)).toBe(false)
    expect(fs.existsSync(files.resultFile)).toBe(false)
    expect(findRegistryByTaskId('task-1')?.entry.submitStatus).toBe('none')
    const incomplete = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(incomplete.status).toBe('incomplete')
    fs.writeFileSync(files.resultFile, `${completeArtifact}\nsecond DONE`)
    const second = await completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    expect(second.status).toBe('submitted')
    expect(second.status).not.toBe('noop')
    expect(second.text).toContain('second DONE')
  })

  it('reuses an inreview pane when HEAD is not startCommit', async () => {
    seed({ startCommit: 'aaa1111' })
    const splits: string[] = []
    const sent: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('n'); return { surface: 'surface:n' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() { return 'session inreview\n$\n' },
    })
    const { pi, cwd, branch, beadId, execCalls } = makePi({ beadId: 'bead-a', head: 'bbb2222', status: 'inreview' })
    const result = await followupVisibleDispatch(pi as any, { beadId, task: 'address review' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('sent')
    expect(sent).toEqual(['address review\n'])
    expect(splits).toEqual([])
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update')).toBe(false)
  })

  it('respawns inreview+shell with one new-split and does not call readiness comments', async () => {
    seed({ startCommit: 'aaa1111' })
    const splits: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('surface:3'); return { surface: 'surface:3' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '❯ ' },
    })
    const { pi, cwd, branch, beadId, execCalls } = makePi({ beadId: 'bead-a', head: 'bbb2222', status: 'inreview' })
    const result = await followupVisibleDispatch(pi as any, { beadId, task: 'respawn please' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('spawned')
    expect(splits).toEqual(['surface:3'])
    expect(execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments')).toEqual([])
  })

  it('retries send once then persists hung without a second process', async () => {
    seed()
    const splits: string[] = []
    let sends = 0
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('surface:h'); return { surface: 'surface:h' } },
      async send() { sends += 1; throw new Error('send failed') },
      async closeSurface() {},
      async readScreen() { return 'session idle' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    const ctx = workflowCtx(cwd, beadId, branch, 'aaa1111')
    await expect(followupVisibleDispatch(pi as any, { beadId, task: 'hop' }, ctx)).rejects.toThrow(/hung cap-2/)
    expect(sends).toBe(2)
    expect(splits).toEqual([])
    const hungEntry = findRegistryByTaskId('task-1')?.entry
    expect(hungEntry?.hung).toBe(true)
    expect(hungEntry?.status).toBe('spawned')
    expect(hungEntry?.sendFailCount).toBe(2)
    sends = 0
    await expect(followupVisibleDispatch(pi as any, { beadId, task: 'hop again' }, ctx)).rejects.toThrow(/hung pane/)
    expect(sends).toBe(0)
    expect(splits).toEqual([])
  })

  it('returns busy once without send or spawn', async () => {
    seed()
    const splits: string[] = []
    const sent: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('x'); return { surface: 'x' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() { return 'thinking\nsession implementing' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    const result = await followupVisibleDispatch(pi as any, { beadId, task: 'wait' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('busy')
    expect(sent).toEqual([])
    expect(splits).toEqual([])
  })

  it('keeps spawned entry when read-screen fails', async () => {
    seed()
    const splits: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('x'); return { surface: 'x' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { throw new Error('transient') },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, task: 'hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/read-screen failed/)
    expect(splits).toEqual([])
    expect(findRegistryByTaskId('task-1')?.entry.status).toBe('spawned')
    expect(findRegistryByTaskId('task-1')?.entry.hung).not.toBe(true)
  })

  it('blocks when there is no live pane', async () => {
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, task: 'hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/нет live pane; first spawn через dispatch_supervisor/)
  })

  it('blocks a blank task', async () => {
    seed()
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { return { surface: 'x' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return 'session idle' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, task: '  \n' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/пустой task/)
  })

  it('live adapter read-screen uses --lines 20', async () => {
    seed()
    const cmuxCalls: string[][] = []
    const { pi, cwd, branch, beadId } = makePi({
      beadId: 'bead-a',
      cmux: async (args) => {
        cmuxCalls.push(args)
        if (args[0] === 'identify') return { stdout: JSON.stringify({ caller: { workspace_ref: 'ws-follow', surface_ref: 'surface:orch' } }), stderr: '', code: 0 }
        if (args[0] === 'read-screen') return { stdout: 'session idle\n', stderr: '', code: 0 }
        if (args[0] === 'send') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 1 }
      },
    })
    const result = await followupVisibleDispatch(pi as any, { beadId, task: 'live hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('sent')
    const read = cmuxCalls.find((args) => args[0] === 'read-screen')
    expect(read).toEqual(['read-screen', '--surface', 'surface:1', '--lines', '20'])
    expect(cmuxCalls.some((args) => args[0] === 'new-split')).toBe(false)
    const send = cmuxCalls.find((args) => args[0] === 'send')
    expect(send?.[3] ?? send?.[2]).toBeDefined()
    expect(cmuxCalls.find((args) => args[0] === 'send')?.includes('live hop\n') || cmuxCalls.some((args) => args.includes('live hop\n'))).toBe(true)
  })

  it('keeps the old spawned entry when respawn send fails', async () => {
    seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { return { surface: 'surface:new' } },
      async send(surface) {
        if (surface === 'surface:new') throw new Error('spawn send failed')
      },
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return 'dead screen' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, task: 'respawn' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/spawn send failed/)
    expect(closed).toEqual(['surface:new'])
    expect(findRegistryByTaskId('task-1')?.entry.status).toBe('spawned')
    expect(findRegistryByTaskId('task-1')?.entry.pane).toBe('surface:1')
  })
})

describe('close_visible_dispatch', () => {
  let tmp: string
  const prevOrch = process.env.ORCH_ROOT
  const prevHome = process.env.HOME

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ld67-close-'))
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

  function seed(entry: Record<string, unknown> = {}) {
    const promptFile = path.join(tmp, 'p.md')
    const taskFile = path.join(tmp, 't.md')
    const resultFile = path.join(tmp, 'r.md')
    const digestFile = path.join(tmp, 'd.digest')
    fs.writeFileSync(promptFile, '# prompt')
    fs.writeFileSync(taskFile, 'task')
    fs.writeFileSync(resultFile, 'result')
    fs.writeFileSync(digestFile, 'digest')
    const file = path.join(tmp, 'ns', 'ws-close', 'dispatch-registry.json')
    saveRegistry(file, {
      entries: [{
        taskId: 'task-ld67',
        beadId: 'bead-a',
        pane: 'surface:99',
        worktree: tmp,
        role: 'test-supervisor',
        model: '',
        taskFile,
        resultFile,
        digestFile,
        promptFile,
        status: 'spawned',
        submitStatus: 'submitted',
        startCommit: 'aaa1111',
        createdAt: 't',
        ...entry,
      }],
    })
    return { file, promptFile, taskFile, resultFile, digestFile }
  }

  it('registers close_visible_dispatch tool', () => {
    const { tools } = makePi({ toolName: 'close_visible_dispatch' })
    expect(tools.close_visible_dispatch).toBeDefined()
  })

  it('calls closeSurface once with registry pane and tombstones after terminal hop', async () => {
    const files = seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-a', status: 'closed' })
    const result = await closeVisibleDispatch(pi as any, { beadId: 'bead-a' })
    expect(result.status).toBe('closed')
    expect(closed).toEqual(['surface:99'])
    expect(result.closed).toEqual(['surface:99'])
    expect(result.tombstoned).toEqual(['task-ld67'])
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('tombstone')
    expect(fs.existsSync(files.promptFile)).toBe(false)
    expect(fs.existsSync(files.taskFile)).toBe(false)
  })

  it('does not call closeSurface when pendingFix (NOT APPROVED path)', async () => {
    seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-a', status: 'inreview' })
    const result = await closeVisibleDispatch(pi as any, { beadId: 'bead-a', pendingFix: true })
    expect(result.status).toBe('skipped')
    expect(closed).toEqual([])
    expect(result.closed).toEqual([])
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('spawned')
  })

  it('blocks close when bead is still live (in_progress / inreview)', async () => {
    seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-a', status: 'inreview' })
    await expect(closeVisibleDispatch(pi as any, { beadId: 'bead-a' })).rejects.toThrow(/not terminal/)
    expect(closed).toEqual([])
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('spawned')
  })

  it('closes only this bead panes and leaves foreign live entries alone', async () => {
    seed()
    const foreignFile = path.join(tmp, 'ns', 'ws-close', 'dispatch-registry.json')
    const registry = loadRegistry(foreignFile)
    registry.entries.push({
      taskId: 'task-foreign',
      beadId: 'bead-foreign',
      pane: 'surface:foreign',
      worktree: tmp,
      role: 'test-supervisor',
      model: '',
      taskFile: path.join(tmp, 'ft.md'),
      resultFile: path.join(tmp, 'fr.md'),
      digestFile: path.join(tmp, 'fd.digest'),
      promptFile: path.join(tmp, 'fp.md'),
      status: 'spawned',
      createdAt: 't',
    })
    saveRegistry(foreignFile, registry)
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-a', status: 'closed' })
    await closeVisibleDispatch(pi as any, { beadId: 'bead-a' })
    expect(closed).toEqual(['surface:99'])
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('tombstone')
    expect(findRegistryByTaskId('task-foreign')?.entry.status).toBe('spawned')
  })

  it('skill and AGENTS document close-surface after terminal and not on pending-fix', () => {
    const skill = fs.readFileSync(path.join(process.cwd(), '.pi/skills/dispatch-supervisor/SKILL.md'), 'utf8')
    const review = fs.readFileSync(path.join(process.cwd(), '.pi/skills/review-bead/SKILL.md'), 'utf8')
    const agents = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8')
    expect(skill).toContain('close_visible_dispatch')
    expect(skill).toContain('close-surface')
    expect(review).toContain('close_visible_dispatch')
    expect(review).toContain('Do not `close_visible_dispatch` while pending-fix')
    expect(agents).toContain('close-surface')
    expect(agents).toContain('close_visible_dispatch')
    expect(agents).toContain('pending-fix')
  })
})
