import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import beadsDispatchExtension, {
  beadSuffixFromId,
  buildCmuxRenameArgv,
  buildNewWorkspaceArgv,
  buildSetWorkspaceColorArgv,
  buildTaskWorkspaceChildCommand,
  buildTaskWorkspaceName,
  buildVisibleChildArgv,
  buildVisibleChildSpawnPayload,
  closeVisibleDispatch,
  completeVisibleDispatch,
  ensureStickyTabTitles,
  extractWorkspaceGroupId,
  findRegistryByTaskId,
  followupVisibleDispatch,
  followupPayloadLooksLikeSpawnArgv,
  findLiveSupervisorSpawnsForWorktree,
  isSpawnLockBlocking,
  loadRegistry,
  mainCheckoutFromGitCommonDir,
  nsDir,
  orchRoot,
  ORCHESTRATOR_TAB_TITLE,
  persistIsolationFiles,
  pickTaskWorkspaceColor,
  posixQuote,
  pruneRegistry,
  renameOnce,
  resolveVisibleSplitAnchor,
  resolveVisibleSplitPlacement,
  spawnTaskWorkspace,
  STICKY_TAB_TITLE_DELAYS_MS,
  validateTaskWorkspaceTitle,
  visibleChildTabTitle,
  visibleCmuxSpawnFailReason,
  requestSupervisorDispatch,
  requestReviewerDispatch,
  resolveDispatchTransport,
  saveRegistry,
  setCmuxAdapterForTests,
  setStickyTabTitleDelayForTests,
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
- src-tauri/PI_RULES.md exists.
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

function workflowCtx(
  cwd: string,
  beadId: string,
  branch: string,
  startCommit: string,
  worktreePath = cwd,
  opts: { hasUI?: boolean } = {},
) {
  return {
    cwd,
    hasUI: opts.hasUI,
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
    expect(buildCmuxRenameArgv('surface:x', 't', 'workspace:28')).toEqual([
      'tab-action', '--action', 'rename', '--surface', 'surface:x', '--title', 't', '--focus', 'false',
      '--workspace', 'workspace:28',
    ])
    expect(buildCmuxRenameArgv('surface:x', 't', '  ')).toEqual([
      'tab-action', '--action', 'rename', '--surface', 'surface:x', '--title', 't', '--focus', 'false',
    ])
  })
})

describe('visible child argv', () => {
  it('fail-closes without --append-system-prompt or --tools', () => {
    expect(validateVisibleChildArgv(['pi', '--no-session'])).toEqual(expect.arrayContaining(['missing --append-system-prompt', 'missing --tools']))
  })

  it('fail-closes when neither --no-session nor --session-dir/--session is present', () => {
    expect(validateVisibleChildArgv(['pi', '--append-system-prompt', 'a.md', '--tools', 'read'])).toEqual(['missing --no-session, throwaway --session-dir, or --session file'])
  })

  it('accepts --no-session mode', () => {
    const argv = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'no-session' }, tools: 'read,bash,edit,write' })
    expect(validateVisibleChildArgv(argv)).toEqual([])
    expect(argv).toContain('--no-session')
    expect(argv).toContain('--tools')
  })

  it('accepts throwaway --session-dir', () => {
    const argv = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'session-dir', dir: '/tmp/sess' } })
    expect(validateVisibleChildArgv(argv)).toEqual([])
    expect(argv).toContain('--session-dir')
    expect(argv).not.toContain('--session')
    expect(argv).toContain('/tmp/sess')
  })

  it('passes agent tools through and defaults when omitted', () => {
    const custom = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'no-session' }, tools: 'read,bash' })
    expect(custom[custom.indexOf('--tools') + 1]).toBe('read,bash')
    const def = buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'no-session' } })
    expect(def[def.indexOf('--tools') + 1]).toBe('read,bash,edit,write')
  })

  it('includes --model when resolved and omits it on inherit', () => {
    const withModel = buildVisibleChildArgv({
      model: 'xai/grok-4.5',
      systemPromptFile: 'a.md',
      taskFile: 't.md',
      session: { kind: 'no-session' },
      tools: 'read,bash,edit,write',
    })
    expect(withModel).toContain('--model')
    expect(withModel[withModel.indexOf('--model') + 1]).toBe('xai/grok-4.5')
    expect(validateVisibleChildArgv(withModel)).toEqual([])

    const inherit = buildVisibleChildArgv({
      systemPromptFile: 'a.md',
      taskFile: 't.md',
      session: { kind: 'no-session' },
      tools: 'read,bash,edit,write',
    })
    expect(inherit).not.toContain('--model')
  })

  it('includes --thinking when set (including off) and omits it on inherit', () => {
    const withHigh = buildVisibleChildArgv({
      thinking: 'high',
      systemPromptFile: 'a.md',
      taskFile: 't.md',
      session: { kind: 'no-session' },
      tools: 'read,bash,edit,write',
    })
    expect(withHigh).toContain('--thinking')
    expect(withHigh[withHigh.indexOf('--thinking') + 1]).toBe('high')
    expect(validateVisibleChildArgv(withHigh)).toEqual([])

    const withOff = buildVisibleChildArgv({
      thinking: 'off',
      systemPromptFile: 'a.md',
      taskFile: 't.md',
      session: { kind: 'no-session' },
      tools: 'read,bash,edit,write',
    })
    expect(withOff).toContain('--thinking')
    expect(withOff[withOff.indexOf('--thinking') + 1]).toBe('off')

    const inherit = buildVisibleChildArgv({
      systemPromptFile: 'a.md',
      taskFile: 't.md',
      session: { kind: 'no-session' },
      tools: 'read,bash,edit,write',
    })
    expect(inherit).not.toContain('--thinking')
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
    setStickyTabTitleDelayForTests(null)
  })

  afterEach(() => {
    setCmuxAdapterForTests(null)
    setStickyTabTitleDelayForTests(null)
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
    // Project agent-models.json maps test-supervisor → standard → xai/grok-4.7
    expect(result.details.model).toBe('xai/grok-4.7')
    expect(result.content[0].text).toContain('model=xai/grok-4.7')
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments).toEqual([])
    expect(fs.existsSync(path.join(tmp, 'ns'))).toBe(false)
  })

  it('omitted transport without UI stays headless and writes nothing on dryRun', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { registered, cwd, branch, beadId, head } = makePi({ execCalls })
    const result = await registered.execute('call-1', { beadId, dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.transport).toBeUndefined()
    expect(result.details.status).not.toBe('spawned')
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments).toEqual([])
  })

  it('omitted transport with hasUI uses cmux spawn-ack on dryRun', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { registered, cwd, branch, beadId, head } = makePi({ execCalls })
    const result = await registered.execute(
      'call-1',
      { beadId, dryRun: true, agent: 'test-supervisor' },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: true }),
    )
    expect(result.details.status).toBe('spawned')
    expect(result.details.transport).toBe('cmux')
    expect(result.details.pane).toBe('')
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments).toEqual([])
  })

  it('explicit transport=headless stays headless even with hasUI', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { registered, cwd, branch, beadId, head } = makePi({ execCalls })
    const result = await registered.execute(
      'call-1',
      { beadId, dryRun: true, agent: 'test-supervisor', transport: 'headless' },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: true }),
    )
    expect(result.details.transport).toBeUndefined()
    expect(result.details.status).not.toBe('spawned')
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
      'documentation-expert.md',
    ]
    for (const name of agents) {
      const text = fs.readFileSync(path.join(process.cwd(), '.pi/agents', name), 'utf8')
      expect(text, name).toContain('Visible dispatch ping')
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
    expect(second.content[0].text).toMatch(/followup_visible_dispatch\(\{ beadId, role: "test-supervisor" \}\)/)
    expect(second.content[0].text).toMatch(/BLOCKED/)
    expect(second.content[0].text).toMatch(/live pane already registered/)
    expect(second.content[0].text).toMatch(/test-supervisor already spawned/)
  })

  it('renames child and orchestrator tabs after visible spawn', async () => {
    const renames: Array<{ surface: string; title: string }> = []
    setStickyTabTitleDelayForTests(async () => {})
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
    // Immediate pair first; full sticky schedule re-applies (not exact length-2).
    expect(renames[0]).toEqual({ surface: 'surface:child', title: 'test-supervisor · fo5d' })
    expect(renames[1]).toEqual({ surface: 'surface:orch', title: ORCHESTRATOR_TAB_TITLE })
    expect(renames.length).toBeGreaterThan(2)
    expect(renames.length).toBe(STICKY_TAB_TITLE_DELAYS_MS.length * 2)
    expect(result.details.renameAttempts).toBe(STICKY_TAB_TITLE_DELAYS_MS.length * 2)
    expect(result.details.renameFailures).toBe(0)
    expect(result.content[0].text).toMatch(/renameAttempts=/)
    expect(visibleChildTabTitle('test-supervisor', beadId)).toBe('test-supervisor · fo5d')
    expect(beadSuffixFromId(beadId)).toBe('fo5d')
  })

  it('live adapter rename uses tab-action argv with --focus false', async () => {
    setCmuxAdapterForTests(null)
    setStickyTabTitleDelayForTests(async () => {})
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
    expect(renames.length).toBeGreaterThan(2)
    expect(renames).toContainEqual(buildCmuxRenameArgv('surface:child', 'test-supervisor · fo5d'))
    expect(renames).toContainEqual(buildCmuxRenameArgv('surface:orch', ORCHESTRATOR_TAB_TITLE))
    expect(buildCmuxRenameArgv('surface:x', 't')).toEqual([
      'tab-action', '--action', 'rename', '--surface', 'surface:x', '--title', 't', '--focus', 'false',
    ])
  })

  it('sticky multi-rename race-sim restores titles after Pi clobber', async () => {
    const renames: Array<{ surface: string; title: string }> = []
    const titles = new Map<string, string>()
    setStickyTabTitleDelayForTests(async () => {})
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-sticky-race' } },
      callerSurface() { return 'surface:orch' },
      async newSplit() { return { surface: 'surface:child' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
      async renameSurface(surface, title) {
        renames.push({ surface, title })
        titles.set(surface, title)
        // After first immediate pair, simulate Pi cwd-title overwrite.
        if (renames.length === 2) {
          titles.set('surface:child', 'π - worktree-basename')
          titles.set('surface:orch', 'π - beads-task-issue-tracker')
        }
      },
    })
    const beadId = 'beads-task-issue-tracker-7kiq'
    const { registered, cwd, branch, head } = makePi({ beadId })
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.status).toBe('spawned')
    expect(renames.length).toBe(STICKY_TAB_TITLE_DELAYS_MS.length * 2)
    expect(titles.get('surface:child')).toBe('test-supervisor · 7kiq')
    expect(titles.get('surface:orch')).toBe(ORCHESTRATOR_TAB_TITLE)
    expect(titles.get('surface:child')).not.toMatch(/^π -/)
  })

  it('sticky rename failures stay fail-soft with metrics', async () => {
    setStickyTabTitleDelayForTests(async () => {})
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-sticky-fail' } },
      callerSurface() { return 'surface:orch' },
      async newSplit() { return { surface: 'surface:child' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
      async renameSurface() { throw new Error('rename boom') },
    })
    const beadId = 'beads-task-issue-tracker-fail'
    const { registered, cwd, branch, head } = makePi({ beadId })
    const result = await registered.execute('call-1', { beadId, transport: 'cmux', agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.status).toBe('spawned')
    expect(result.details.renameAttempts).toBe(STICKY_TAB_TITLE_DELAYS_MS.length * 2)
    expect(result.details.renameFailures).toBe(result.details.renameAttempts)
    expect(result.details.renameLastError).toMatch(/rename boom/)
    expect(result.content[0].text).toMatch(/renameFailures=/)
  })

  it('dual spawn applies own role titles without peer overwrite', async () => {
    const renames: Array<{ surface: string; title: string }> = []
    let splitN = 0
    setStickyTabTitleDelayForTests(async () => {})
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-sticky-dual' } },
      callerSurface() { return 'surface:orch' },
      async newSplit() {
        splitN += 1
        return { surface: splitN === 1 ? 'surface:sup' : 'surface:rev' }
      },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
      async renameSurface(surface, title) { renames.push({ surface, title }) },
    })
    const beadId = 'beads-task-issue-tracker-dual'
    const firstPi = makePi({ beadId })
    const ctx = workflowCtx(firstPi.cwd, beadId, firstPi.branch, firstPi.head)
    const first = await firstPi.registered.execute(
      'call-1',
      { beadId, transport: 'cmux', agent: 'test-supervisor' },
      undefined,
      undefined,
      ctx,
    )
    expect(first.details.status).toBe('spawned')
    const secondPi = makePi({
      toolName: 'dispatch_reviewer',
      beadId,
      status: 'inreview',
      cwd: firstPi.cwd,
      branch: firstPi.branch,
      head: firstPi.head,
    })
    const second = await secondPi.registered.execute(
      'call-2',
      { beadId, transport: 'cmux', agent: 'code-reviewer' },
      undefined,
      undefined,
      ctx,
    )
    expect(second.details.status).toBe('spawned')
    expect(renames.some((r) => r.surface === 'surface:sup' && r.title === 'test-supervisor · dual')).toBe(true)
    expect(renames.some((r) => r.surface === 'surface:rev' && r.title === 'code-reviewer · dual')).toBe(true)
    expect(renames.some((r) => r.surface === 'surface:sup' && r.title.includes('code-reviewer'))).toBe(false)
    expect(renames.some((r) => r.surface === 'surface:rev' && r.title.includes('test-supervisor'))).toBe(false)
    expect(renames.every((r) => r.surface === 'surface:sup' || r.surface === 'surface:rev' || r.surface === 'surface:orch')).toBe(true)
  })

  it('ensureStickyTabTitles honors AbortSignal mid-schedule', async () => {
    const renames: Array<{ surface: string; title: string }> = []
    const adapter = {
      async identify() { return { workspaceId: 'x' } },
      async newSplit() { return { surface: 'c' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
      async renameSurface(surface: string, title: string) { renames.push({ surface, title }) },
    }
    const controller = new AbortController()
    let ticks = 0
    const metrics = await ensureStickyTabTitles(adapter as any, {
      childSurface: 'surface:c',
      childTitle: 'role · x',
      orchSurface: 'surface:o',
      orchTitle: ORCHESTRATOR_TAB_TITLE,
      schedule: [...STICKY_TAB_TITLE_DELAYS_MS],
      delay: async () => {
        ticks += 1
        if (ticks >= 1) controller.abort()
      },
      signal: controller.signal,
    })
    expect(metrics.renameAttempts).toBeGreaterThan(0)
    expect(metrics.renameAttempts).toBeLessThan(STICKY_TAB_TITLE_DELAYS_MS.length * 2)
    expect(typeof renameOnce).toBe('function')
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

describe('resolveDispatchTransport', () => {
  it('explicit transport always wins', () => {
    expect(resolveDispatchTransport({ transport: 'headless' }, { hasUI: true })).toBe('headless')
    expect(resolveDispatchTransport({ transport: 'cmux' }, { hasUI: false })).toBe('cmux')
  })

  it('omit with hasUI → cmux; omit without UI → headless', () => {
    expect(resolveDispatchTransport({}, { hasUI: true })).toBe('cmux')
    expect(resolveDispatchTransport({}, { hasUI: false })).toBe('headless')
    expect(resolveDispatchTransport({}, null)).toBe('headless')
    expect(resolveDispatchTransport({})).toBe('headless')
  })
})

describe('reviewer/docs transport', () => {
  it('schemas: supervisor, reviewer, and docs have transport', () => {
    const { tools } = makePi({})
    expect(tools.dispatch_supervisor.parameters.properties.transport.enum).toEqual(['headless', 'cmux'])
    expect(tools.dispatch_reviewer.parameters.properties.transport.enum).toEqual(['headless', 'cmux'])
    expect(tools.dispatch_docs_agent.parameters.properties.transport.enum).toEqual(['headless', 'cmux'])
    expect(tools.dispatch_supervisor.parameters.properties.transport.default).toBeUndefined()
    expect(tools.dispatch_reviewer.parameters.properties.transport.default).toBeUndefined()
    expect(tools.dispatch_supervisor.parameters.properties.transport.description).toMatch(/Omit: cmux when interactive/)
    expect(tools.followup_visible_dispatch).toBeDefined()
    expect(tools.followup_visible_dispatch.description).toMatch(/Единственный typed hop/)
    expect(tools.followup_visible_dispatch.description).toMatch(/documentation-expert/)
    expect(tools.followup_visible_dispatch.parameters.required).toEqual(['beadId', 'task', 'role'])
    expect(tools.dispatch_reviewer.parameters.additionalProperties).toBe(false)
  })
})

describe('dispatch_docs_agent visible cmux', () => {
  let tmp: string
  const prevOrch = process.env.ORCH_ROOT
  const prevHome = process.env.HOME
  let prevCmuxSocket: string | undefined
  let prevCmuxWorkspace: string | undefined

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '0qsm-docs-'))
    process.env.ORCH_ROOT = tmp
    process.env.HOME = tmp
    prevCmuxSocket = process.env.CMUX_SOCKET_PATH
    prevCmuxWorkspace = process.env.CMUX_WORKSPACE_ID
    delete process.env.CMUX_SOCKET_PATH
    delete process.env.CMUX_WORKSPACE_ID
    setCmuxAdapterForTests(null)
    setStickyTabTitleDelayForTests(async () => {})
  })

  afterEach(() => {
    setCmuxAdapterForTests(null)
    setStickyTabTitleDelayForTests(null)
    if (prevOrch === undefined) delete process.env.ORCH_ROOT
    else process.env.ORCH_ROOT = prevOrch
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevCmuxSocket === undefined) delete process.env.CMUX_SOCKET_PATH
    else process.env.CMUX_SOCKET_PATH = prevCmuxSocket
    if (prevCmuxWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID
    else process.env.CMUX_WORKSPACE_ID = prevCmuxWorkspace
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('omit/hasUI spawn-ack with live registry row and no dashboard card', async () => {
    setCmuxAdapterForTests({
      callerSurface: () => 'surface:orch',
      async identify() { return { workspaceId: 'ws-docs' } },
      async newSplit() { return { surface: 'surface:docs' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
      async renameSurface() {},
    })
    const { tools, cwd, branch, beadId, head } = makePi({ toolName: 'dispatch_docs_agent', beadId: 'bead-d' })
    const result = await tools.dispatch_docs_agent.execute(
      'd1',
      { beadId },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: true }),
    )
    expect(result.details.status).toBe('spawned')
    expect(result.details.pane).toBe('surface:docs')
    expect(result.details.agent).toBe('documentation-expert')
    expect(result.details.error).toBeUndefined()
    const entry = findRegistryByTaskId(result.details.registryKey)?.entry
    expect(entry?.status).toBe('spawned')
    expect(entry?.role).toBe('documentation-expert')
    expect(entry?.kind).toBe('workflow')
    expect(entry?.layoutColumn).toBe(0)
  })

  it('visible docs taskBody has WHEN-DONE, ping.sh, and stdout is not delivery', async () => {
    setCmuxAdapterForTests({
      callerSurface: () => 'surface:orch',
      async identify() { return { workspaceId: 'ws-docs-body' } },
      async newSplit() { return { surface: 'surface:docs' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
      async renameSurface() {},
    })
    const { tools, cwd, branch, beadId, head } = makePi({ toolName: 'dispatch_docs_agent', beadId: 'bead-d' })
    const result = await tools.dispatch_docs_agent.execute(
      'd1',
      { beadId },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: true }),
    )
    expect(result.details.status).toBe('spawned')
    const body = fs.readFileSync(result.details.taskFile!, 'utf8')
    const pingSh = path.join(cwd, '.pi/orchestrator/ping.sh')
    expect(body).toContain('WHEN YOU BELIEVE YOUR CONTRACT IS DONE')
    expect(body).toContain('Child stdout is not delivery')
    expect(body).toContain(`bash '${pingSh}'`)
    expect(body).toContain("AGENT_NAME='documentation-expert'")
    expect(body).toContain('Chat DOCS REPORT is not delivery')
    expect(body).toMatch(/Checklist: nonempty result file/)
  })

  it('duplicate live docs spawn hints followup with documentation-expert role', async () => {
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-docs-dup' } },
      async newSplit() { return { surface: 'surface:docs' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return '' },
    })
    const { tools, cwd, branch, beadId, head } = makePi({ toolName: 'dispatch_docs_agent', beadId: 'bead-d' })
    const ctx = workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: true })
    const first = await tools.dispatch_docs_agent.execute('d1', { beadId }, undefined, undefined, ctx)
    expect(first.details.status).toBe('spawned')
    const second = await tools.dispatch_docs_agent.execute('d2', { beadId }, undefined, undefined, ctx)
    expect(second.content[0].text).toMatch(/BLOCKED/)
    expect(second.content[0].text).toMatch(/followup_visible_dispatch\(\{ beadId, role: "documentation-expert" \}\)/)
  })

  it('omitted transport without UI stays headless on dryRun', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { tools, cwd, branch, beadId, head } = makePi({ toolName: 'dispatch_docs_agent', beadId: 'bead-d', execCalls })
    const result = await tools.dispatch_docs_agent.execute(
      'd1',
      { beadId, dryRun: true },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: false }),
    )
    expect(result.details.status).not.toBe('spawned')
    expect(result.details.transport).toBeUndefined()
    expect(result.details.pane).toBeUndefined()
    expect(result.details.error).toBeUndefined()
    expect(result.content[0].text).not.toMatch(/dispatch_docs_agent не выполнен/)
    const comments = execCalls.filter((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add')
    expect(comments).toEqual([])
    expect(fs.existsSync(path.join(tmp, 'ns'))).toBe(false)
    expect(result.details.output).not.toMatch(/ping\.sh/)
    expect(result.details.output).not.toContain('WHEN YOU BELIEVE YOUR CONTRACT IS DONE')
  })

  it('omitted transport without UI but CMUX_SOCKET_PATH fails closed', async () => {
    process.env.CMUX_SOCKET_PATH = '/tmp/hpra-fake-cmux.sock'
    const { tools, cwd, branch, beadId, head } = makePi({ toolName: 'dispatch_docs_agent', beadId: 'bead-d' })
    const result = await tools.dispatch_docs_agent.execute(
      'd1',
      { beadId },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: false }),
    )
    expect(result.details.error).toMatch(/интерактивная cmux-сессия обнаружена, но hasUI=false/)
    expect(result.content[0].text).toMatch(/dispatch_docs_agent не выполнен:/)
    expect(result.content[0].text).toMatch(/интерактивная cmux-сессия/)
    expect(result.details.status).not.toBe('spawned')
    expect(result.details.pane).toBeUndefined()
    expect(result.details.registryKey).toBeUndefined()
    expect(fs.existsSync(path.join(tmp, 'ns'))).toBe(false)
  })

  it('complete_visible_dispatch docs is result-only and does not inreview', async () => {
    const resultFile = path.join(tmp, 'docs-result.md')
    const digestFile = path.join(tmp, 'docs.digest')
    fs.writeFileSync(resultFile, 'docs report done')
    fs.writeFileSync(digestFile, 'docs digest')
    const file = path.join(tmp, 'ns', 'ws-c', 'dispatch-registry.json')
    saveRegistry(file, {
      entries: [{
        taskId: 'task-docs',
        beadId: 'bead-d',
        pane: 'surface:docs',
        worktree: tmp,
        role: 'documentation-expert',
        model: '',
        taskFile: path.join(tmp, 't.md'),
        resultFile,
        digestFile,
        promptFile: path.join(tmp, 'p.md'),
        status: 'spawned',
        submitStatus: 'none',
        startCommit: 'aaa1111',
        createdAt: 't',
        kind: 'workflow',
        layoutColumn: 0,
      }],
    })
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { pi } = makePi({ beadId: 'bead-d', head: 'bbb2222', execCalls })
    const result = await completeVisibleDispatch(pi as any, { taskId: 'task-docs' })
    expect(result.status).toBe('result-only')
    expect(findRegistryByTaskId('task-docs')?.entry.submitStatus).toBe('result-only')
    const comments = execCalls.filter((c) => c.command === 'bd' && c.args[0] === 'comments' && c.args[1] === 'add')
    expect(comments.some((c) => c.args.join(' ').includes('DISPATCH RESULT (documentation-expert)'))).toBe(true)
    expect(execCalls.some((c) => c.command === 'bd' && c.args.includes('inreview'))).toBe(false)
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

  it('omitted transport without UI stays headless', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { tools, cwd, branch, beadId, head } = reviewerPi({ execCalls })
    const result = await tools.dispatch_reviewer.execute('call-1', { beadId, dryRun: true }, undefined, undefined, workflowCtx(cwd, beadId, branch, head))
    expect(result.details.transport).toBeUndefined()
    expect(result.details.status).not.toBe('spawned')
  })

  it('omitted transport with hasUI uses cmux for reviewer', async () => {
    const execCalls: Array<{ command: string; args: string[] }> = []
    const { tools, cwd, branch, beadId, head } = reviewerPi({ execCalls })
    const result = await tools.dispatch_reviewer.execute(
      'call-1',
      { beadId, dryRun: true },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: true }),
    )
    expect(result.details.status).toBe('spawned')
    expect(result.details.transport).toBe('cmux')
  })

  it('explicit transport=headless stays headless for reviewer even with hasUI', async () => {
    const { tools, cwd, branch, beadId, head } = reviewerPi()
    const result = await tools.dispatch_reviewer.execute(
      'call-1',
      { beadId, dryRun: true, transport: 'headless' },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head, cwd, { hasUI: true }),
    )
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
    const anchors: Array<string | undefined> = []
    setCmuxAdapterForTests({
      callerSurface: () => 'surface:orch',
      async identify() { return { workspaceId: 'ws-two' } },
      async newSplit(opts) {
        anchors.push(opts?.anchorSurface)
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
    // kgvd: sequential anchors [orch, first live supervisor], never orch on second spawn
    expect(anchors).toEqual(['surface:orch', 'surface:1'])
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

  it('shares one concurrent completeVisibleDispatch promise per taskId', async () => {
    seed({})
    fs.writeFileSync(path.join(tmp, 'd.digest'), 'still working')
    const { pi } = makePi({ head: 'aaa1111' })
    const first = completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    const second = completeVisibleDispatch(pi as any, { taskId: 'task-1' })
    const [a, b] = await Promise.all([first, second])
    expect(a.status).toBe('result-only')
    expect(b.status).toBe('result-only')
    expect(a).toEqual(b)
  })

  it('requestReviewerDispatch uses registered dispatch_reviewer API', async () => {
    const { pi, cwd, branch, beadId, head, tools } = makePi({
      status: 'inreview',
      head: 'aaa1111',
    })
    expect(tools.dispatch_reviewer).toBeDefined()
    const result = await requestReviewerDispatch(
      pi,
      { beadId, dryRun: true, transport: 'headless' },
      workflowCtx(cwd, beadId, branch, head),
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain('agent=code-reviewer')
  })

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
    setStickyTabTitleDelayForTests(null)
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
    seed({ callerSurface: 'surface:orch' })
    const splits: string[] = []
    const sent: string[] = []
    const renames: Array<{ surface: string; title: string }> = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      callerSurface() { return 'surface:orch' },
      async newSplit() { splits.push('surface:99'); return { surface: 'surface:99' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() { return 'session idle\n$\n' },
      async renameSurface(surface, title) { renames.push({ surface, title }) },
    })
    const { pi, cwd, branch, beadId, emitted } = makePi({ beadId: 'bead-a', head: 'bbb2222' })
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'Fix the pane' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('sent')
    expect(sent).toEqual(['Fix the pane\n'])
    expect(splits).toEqual([])
    // waiting reuse: one re-apply pair + metrics in text
    expect(renames).toEqual([
      { surface: 'surface:1', title: 'test-supervisor · a' },
      { surface: 'surface:orch', title: ORCHESTRATOR_TAB_TITLE },
    ])
    expect(result.renameAttempts).toBe(2)
    expect(result.renameFailures).toBe(0)
    expect(result.text).toMatch(/renameAttempts=2/)
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
    const renames: Array<{ surface: string; title: string }> = []
    setStickyTabTitleDelayForTests(async () => {})
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      callerSurface() { return 'surface:orch' },
      async newSplit() { splits.push('surface:2'); return { surface: 'surface:2' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return 'user@host ~/proj $\n' },
      async renameSurface(surface, title) { renames.push({ surface, title }) },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'Fix the pane' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('spawned')
    expect(splits).toEqual(['surface:2'])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^cd /)
    expect(sent[0]).toContain('pi')
    expect(sent[0]).not.toBe('Fix the pane\n')
    expect(closed).toEqual(['surface:1'])
    expect(findRegistryByTaskId('task-1')?.entry.pane).toBe('surface:2')
    expect(findRegistryByTaskId('task-1')?.entry.startCommit).toBe('aaa1111')
    // shell/respawn sticky schedule: child+orch on full delay list
    expect(renames[0]).toEqual({ surface: 'surface:2', title: 'test-supervisor · a' })
    expect(renames[1]).toEqual({ surface: 'surface:orch', title: ORCHESTRATOR_TAB_TITLE })
    expect(renames.length).toBe(STICKY_TAB_TITLE_DELAYS_MS.length * 2)
    expect(result.renameAttempts).toBe(STICKY_TAB_TITLE_DELAYS_MS.length * 2)
    expect(result.renameFailures).toBe(0)
    expect(result.text).toMatch(/renameAttempts=/)
  })

  it('registered tool execute passes AbortSignal without ReferenceError and returns sticky metrics', async () => {
    seed({ callerSurface: 'surface:orch' })
    setStickyTabTitleDelayForTests(async () => {})
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      callerSurface() { return 'surface:orch' },
      async newSplit() { return { surface: 'surface:99' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return 'session idle\n$\n' },
      async renameSurface() {},
    })
    const { tools, cwd, branch, beadId } = makePi({ beadId: 'bead-a', head: 'bbb2222' })
    const controller = new AbortController()
    const result = await tools.followup_visible_dispatch.execute(
      'call-followup-signal',
      { beadId, role: 'test-supervisor', task: 'Fix via registered tool' },
      controller.signal,
      undefined,
      workflowCtx(cwd, beadId, branch, 'aaa1111'),
    )
    expect(result.details?.error).toBeUndefined()
    expect(result.content[0].text).not.toMatch(/ReferenceError|signal is not defined/)
    expect(result.details.status).toBe('sent')
    expect(result.details.renameAttempts).toBe(2)
    expect(result.details.renameFailures).toBe(0)
    expect(result.content[0].text).toMatch(/renameAttempts=2/)
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
    await followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'second hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
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
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'address review' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
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
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'respawn please' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
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
    await expect(followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'hop' }, ctx)).rejects.toThrow(/hung cap-2/)
    expect(sends).toBe(2)
    expect(splits).toEqual([])
    const hungEntry = findRegistryByTaskId('task-1')?.entry
    expect(hungEntry?.hung).toBe(true)
    expect(hungEntry?.status).toBe('spawned')
    expect(hungEntry?.sendFailCount).toBe(2)
    sends = 0
    await expect(followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'hop again' }, ctx)).rejects.toThrow(/hung pane/)
    expect(sends).toBe(0)
    expect(splits).toEqual([])
  })

  it('returns busy once without send or spawn', async () => {
    seed()
    const splits: string[] = []
    const sent: string[] = []
    const renames: Array<{ surface: string; title: string }> = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('x'); return { surface: 'x' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() { return 'thinking\nsession implementing' },
      async renameSurface(surface, title) { renames.push({ surface, title }) },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'wait' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('busy')
    expect(sent).toEqual([])
    expect(splits).toEqual([])
    expect(renames).toEqual([])
    expect(result.renameAttempts).toBe(0)
    expect(result.renameFailures).toBe(0)
    expect(result.text).toMatch(/renameAttempts=0/)
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
    await expect(followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/read-screen failed/)
    expect(splits).toEqual([])
    expect(findRegistryByTaskId('task-1')?.entry.status).toBe('spawned')
    expect(findRegistryByTaskId('task-1')?.entry.hung).not.toBe(true)
  })

  it('blocks when there is no live pane', async () => {
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/нет live pane; first spawn через dispatch_supervisor/)
  })

  it('unique documentation-expert pane without role is BLOCKED', async () => {
    seed({ role: 'documentation-expert' })
    const sent: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { return { surface: 'surface:99' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() {
        return 'DOCS REPORT\nStatus: NOTHING_TO_UPDATE\nsession idle | bead=bead-a\n$\n'
      },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a', head: 'bbb2222' })
    await expect(followupVisibleDispatch(pi as any, { beadId, task: 'запиши result/digest и пингань' } as any, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/укажите role/)
    expect(sent).toEqual([])
  })

  it('empty role on unique documentation-expert pane is BLOCKED', async () => {
    seed({ role: 'documentation-expert' })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a', head: 'bbb2222' })
    await expect(followupVisibleDispatch(pi as any, { beadId, role: '  ', task: 'hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/укажите role/)
  })

  it('unique documentation-expert pane with role + idle DOCS REPORT sends followup', async () => {
    seed({ role: 'documentation-expert' })
    const sent: string[] = []
    const splits: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { splits.push('surface:99'); return { surface: 'surface:99' } },
      async send(_surface, text) { sent.push(text) },
      async closeSurface() {},
      async readScreen() {
        return 'DOCS REPORT\nStatus: NOTHING_TO_UPDATE\nsession idle | bead=bead-a\n$\n'
      },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a', head: 'bbb2222' })
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'documentation-expert', task: 'запиши result/digest и пингань' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('sent')
    expect(sent).toEqual(['запиши result/digest и пингань\n'])
    expect(splits).toEqual([])
    expect(fs.existsSync(path.join(tmp, 'd.digest'))).toBe(false)
  })

  it('two live roles without role are BLOCKED until role is specified', async () => {
    const files = seed()
    const registry = loadRegistry(files.file)
    registry.entries.push({
      ...registry.entries[0]!,
      taskId: 'task-docs',
      pane: 'surface:docs',
      role: 'documentation-expert',
    })
    saveRegistry(files.file, registry)
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return 'session idle\n$\n' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, task: 'hop' } as any, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/укажите role/)
  })

  it('two live roles with documentation-expert hops to the docs pane', async () => {
    const files = seed()
    const registry = loadRegistry(files.file)
    registry.entries.push({
      ...registry.entries[0]!,
      taskId: 'task-docs',
      pane: 'surface:docs',
      role: 'documentation-expert',
    })
    saveRegistry(files.file, registry)
    const sent: Array<{ surface: string; text: string }> = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-follow' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send(surface, text) { sent.push({ surface, text }) },
      async closeSurface() {},
      async readScreen() { return 'session idle\n$\n' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'documentation-expert', task: 'hop docs' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
    expect(result.status).toBe('sent')
    expect(sent).toEqual([{ surface: 'surface:docs', text: 'hop docs\n' }])
  })

  it('two live roles with unknown role have no live pane', async () => {
    const files = seed()
    const registry = loadRegistry(files.file)
    registry.entries.push({
      ...registry.entries[0]!,
      taskId: 'task-docs',
      pane: 'surface:docs',
      role: 'documentation-expert',
    })
    saveRegistry(files.file, registry)
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, role: 'code-reviewer', task: 'hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/нет live pane; first spawn через dispatch_reviewer/)
  })

  it('missing documentation-expert pane hints dispatch_docs_agent', async () => {
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, role: 'documentation-expert', task: 'hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/нет live pane; first spawn через dispatch_docs_agent/)
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
    await expect(followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: '  \n' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/пустой task/)
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
    const result = await followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'live hop' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))
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
      async readScreen() { return '' },
    })
    const { pi, cwd, branch, beadId } = makePi({ beadId: 'bead-a' })
    await expect(followupVisibleDispatch(pi as any, { beadId, role: 'test-supervisor', task: 'respawn' }, workflowCtx(cwd, beadId, branch, 'aaa1111'))).rejects.toThrow(/spawn send failed/)
    expect(closed).toEqual(['surface:new'])
    expect(findRegistryByTaskId('task-1')?.entry.status).toBe('spawned')
    expect(findRegistryByTaskId('task-1')?.entry.pane).toBe('surface:1')
  })
})

describe('resolveVisibleSplitPlacement (2-column down-stack)', () => {
  const pane = (id: string, createdAt: string, layoutColumn?: number, taskId = `task-${id}`) => ({
    pane: `surface:${id}`,
    status: 'spawned' as const,
    createdAt,
    taskId,
    layoutColumn,
  })

  it('0 live → orch, right, column 0', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [],
    })).toEqual({ anchorSurface: 'surface:orch', direction: 'right', layoutColumn: 0 })
    expect(resolveVisibleSplitAnchor({
      callerSurface: 'surface:orch',
      liveAgentPanes: [],
    })).toBe('surface:orch')
  })

  it('1 live → right of that agent, column 1, never orch', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [pane('sup', '2026-09-14T10:00:00.000Z', 0)],
    })).toEqual({ anchorSurface: 'surface:sup', direction: 'right', layoutColumn: 1 })
  })

  it('2 live (1+1) → down, column 0', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        pane('a', '2026-09-14T10:00:00.000Z', 0),
        pane('b', '2026-09-14T11:00:00.000Z', 1),
      ],
    })).toEqual({ anchorSurface: 'surface:a', direction: 'down', layoutColumn: 0 })
  })

  it('3 live (2+1) → down, column 1', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        pane('a', 't1', 0),
        pane('b', 't2', 1),
        pane('c', 't3', 0),
      ],
    })).toEqual({ anchorSurface: 'surface:b', direction: 'down', layoutColumn: 1 })
  })

  it('4 live (2+2) → down, column 0', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        pane('a', 't1', 0),
        pane('b', 't2', 1),
        pane('c', 't3', 0),
        pane('d', 't4', 1),
      ],
    })).toEqual({ anchorSurface: 'surface:c', direction: 'down', layoutColumn: 0 })
  })

  it('2 live both column 1 → down on occupied column, never right', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        pane('b', 't1', 1),
        pane('c', 't2', 1),
      ],
    })).toEqual({ anchorSurface: 'surface:c', direction: 'down', layoutColumn: 1 })
  })

  it('tie-break uses smaller column index', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        pane('left', 't1', 0),
        pane('right', 't2', 1),
      ],
    }).layoutColumn).toBe(0)
  })

  it('excludePane solo falls back to orch; with peer anchors peer', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [pane('self', 't', 0)],
      excludePane: 'surface:self',
    })).toEqual({ anchorSurface: 'surface:orch', direction: 'right', layoutColumn: 0 })
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        pane('sup', '2026-09-14T10:00:00.000Z', 0),
        pane('rev', '2026-09-14T11:00:00.000Z', 1),
      ],
      excludePane: 'surface:rev',
    })).toEqual({ anchorSurface: 'surface:sup', direction: 'right', layoutColumn: 1 })
  })

  it('respawn preserveColumn stacks down in that column', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        pane('a', 't1', 0),
        pane('b', 't2', 1),
        pane('c', 't3', 0),
      ],
      excludePane: 'surface:c',
      preserveColumn: 0,
    })).toEqual({ anchorSurface: 'surface:a', direction: 'down', layoutColumn: 0 })
  })

  it('legacy entries without layoutColumn map columns by createdAt', () => {
    expect(resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        { pane: 'surface:b', status: 'spawned', createdAt: '2026-09-14T11:00:00.000Z', taskId: 'task-b' },
        { pane: 'surface:a', status: 'spawned', createdAt: '2026-09-14T10:00:00.000Z', taskId: 'task-z' },
      ],
    })).toEqual({ anchorSurface: 'surface:a', direction: 'down', layoutColumn: 0 })
  })

  it('ignores tombstone panes and never anchors orch when live agents exist', () => {
    const placement = resolveVisibleSplitPlacement({
      callerSurface: 'surface:orch',
      liveAgentPanes: [
        { pane: 'surface:dead', status: 'tombstone', createdAt: 't', taskId: 'task-old' },
        pane('live', 't2', 0),
      ],
    })
    expect(placement.anchorSurface).toBe('surface:live')
    expect(placement.anchorSurface).not.toBe('surface:orch')
  })
})

describe('kgvd dual-agent layout wiring', () => {
  let tmp: string
  const prevOrch = process.env.ORCH_ROOT
  const prevHome = process.env.HOME

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kgvd-layout-'))
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

  it('live second spawn argv is right of first agent with --focus false, never orch', async () => {
    setCmuxAdapterForTests(null)
    const cmuxCalls: string[][] = []
    let splitN = 0
    const beadId = 'beads-task-issue-tracker-kgvd'
    const { tools, cwd, branch, head } = makePi({
      beadId,
      status: 'in_progress',
      cmux: async (args) => {
        cmuxCalls.push(args)
        if (args[0] === 'identify') {
          return {
            stdout: JSON.stringify({
              caller: { workspace_ref: 'ws-kgvd-live', surface_ref: 'surface:orch' },
            }),
            stderr: '',
            code: 0,
          }
        }
        if (args[0] === 'new-split') {
          splitN += 1
          return { stdout: `surface:agent${splitN}\n`, stderr: '', code: 0 }
        }
        if (args[0] === 'send') return { stdout: '', stderr: '', code: 0 }
        if (args[0] === 'tab-action') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    })
    const supervisor = await tools.dispatch_supervisor.execute(
      's1',
      { beadId, transport: 'cmux', agent: 'test-supervisor' },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head),
    )
    expect(supervisor.details.status).toBe('spawned')
    const reviewerPiInst = makePi({
      toolName: 'dispatch_reviewer',
      beadId,
      status: 'inreview',
      head,
      cwd,
      branch,
      cmux: async (args) => {
        cmuxCalls.push(args)
        if (args[0] === 'identify') {
          return {
            stdout: JSON.stringify({
              caller: { workspace_ref: 'ws-kgvd-live', surface_ref: 'surface:orch' },
            }),
            stderr: '',
            code: 0,
          }
        }
        if (args[0] === 'new-split') {
          splitN += 1
          return { stdout: `surface:agent${splitN}\n`, stderr: '', code: 0 }
        }
        if (args[0] === 'send') return { stdout: '', stderr: '', code: 0 }
        if (args[0] === 'tab-action') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    })
    const reviewer = await reviewerPiInst.tools.dispatch_reviewer.execute(
      'r1',
      { beadId, transport: 'cmux' },
      undefined,
      undefined,
      workflowCtx(cwd, beadId, branch, head),
    )
    expect(reviewer.details.status).toBe('spawned')
    const splits = cmuxCalls.filter((args) => args[0] === 'new-split')
    expect(splits).toHaveLength(2)
    expect(splits[0]).toEqual(['new-split', 'right', '--surface', 'surface:orch', '--focus', 'false'])
    expect(splits[1]).toEqual(['new-split', 'right', '--surface', 'surface:agent1', '--focus', 'false'])
    expect(splits[1]).not.toContain('surface:orch')
  })

  it('respawn exclude-self: solo anchors orch; with peer anchors peer', async () => {
    const soloTmp = path.join(tmp, 'solo')
    fs.mkdirSync(soloTmp, { recursive: true })
    const taskFile = path.join(soloTmp, 't.md')
    const promptFile = path.join(soloTmp, 'p.md')
    fs.writeFileSync(taskFile, 'old')
    fs.writeFileSync(promptFile, '# p')
    const file = path.join(tmp, 'ns', 'ws-kgvd-respawn', 'dispatch-registry.json')
    saveRegistry(file, {
      entries: [{
        taskId: 'task-sup',
        beadId: 'bead-kgvd',
        pane: 'surface:sup-old',
        worktree: process.cwd(),
        role: 'test-supervisor',
        model: '',
        taskFile,
        resultFile: path.join(soloTmp, 'r.md'),
        digestFile: path.join(soloTmp, 'd.digest'),
        promptFile,
        status: 'spawned',
        submitStatus: 'none',
        callerSurface: 'surface:orch',
        startCommit: 'aaa1111',
        createdAt: '2026-09-14T10:00:00.000Z',
      }],
    })
    const soloAnchors: Array<string | undefined> = []
    setCmuxAdapterForTests({
      callerSurface: () => 'surface:orch',
      async identify() { return { workspaceId: 'ws-kgvd-respawn' } },
      async newSplit(opts) {
        soloAnchors.push(opts?.anchorSurface)
        return { surface: 'surface:sup-new' }
      },
      async send() {},
      async closeSurface() {},
      async readScreen() { return 'user@host ~/proj $\n' },
    })
    const { pi, cwd, branch } = makePi({ beadId: 'bead-kgvd' })
    const solo = await followupVisibleDispatch(pi as any, { beadId: 'bead-kgvd', role: 'test-supervisor', task: 'respawn solo' }, workflowCtx(cwd, 'bead-kgvd', branch, 'aaa1111'))
    expect(solo.status).toBe('spawned')
    expect(soloAnchors).toEqual(['surface:orch'])

    // peer present: exclude self → anchor supervisor
    const peerTask = path.join(soloTmp, 'rev-t.md')
    const peerPrompt = path.join(soloTmp, 'rev-p.md')
    fs.writeFileSync(peerTask, 'rev')
    fs.writeFileSync(peerPrompt, '# rev')
    saveRegistry(file, {
      entries: [
        {
          taskId: 'task-sup2',
          beadId: 'bead-kgvd',
          pane: 'surface:sup-live',
          worktree: process.cwd(),
          role: 'test-supervisor',
          model: '',
          taskFile,
          resultFile: path.join(soloTmp, 'r2.md'),
          digestFile: path.join(soloTmp, 'd2.digest'),
          promptFile,
          status: 'spawned',
          submitStatus: 'none',
          callerSurface: 'surface:orch',
          startCommit: 'aaa1111',
          createdAt: '2026-09-14T10:00:00.000Z',
        },
        {
          taskId: 'task-rev',
          beadId: 'bead-kgvd',
          pane: 'surface:rev-old',
          worktree: process.cwd(),
          role: 'code-reviewer',
          model: '',
          taskFile: peerTask,
          resultFile: path.join(soloTmp, 'rr.md'),
          digestFile: path.join(soloTmp, 'rd.digest'),
          promptFile: peerPrompt,
          status: 'spawned',
          submitStatus: 'none',
          callerSurface: 'surface:orch',
          startCommit: 'aaa1111',
          createdAt: '2026-09-14T11:00:00.000Z',
        },
      ],
    })
    const peerAnchors: Array<string | undefined> = []
    setCmuxAdapterForTests({
      callerSurface: () => 'surface:orch',
      async identify() { return { workspaceId: 'ws-kgvd-respawn' } },
      async newSplit(opts) {
        peerAnchors.push(opts?.anchorSurface)
        return { surface: 'surface:rev-new' }
      },
      async send() {},
      async closeSurface() {},
      async readScreen() { return 'user@host ~/proj $\n' },
    })
    const peerPi = makePi({ beadId: 'bead-kgvd', status: 'inreview' })
    const peer = await followupVisibleDispatch(
      peerPi.pi as any,
      { beadId: 'bead-kgvd', role: 'code-reviewer', task: 'respawn peer' },
      workflowCtx(peerPi.cwd, 'bead-kgvd', peerPi.branch, 'aaa1111'),
    )
    expect(peer.status).toBe('spawned')
    expect(peerAnchors).toEqual(['surface:sup-live'])
    expect(peerAnchors[0]).not.toBe('surface:orch')
  })

  it('respawn after col-0 gone records placement column, not the old column', async () => {
    const filesDir = path.join(tmp, 'col0-gone')
    fs.mkdirSync(filesDir, { recursive: true })
    const taskFile = path.join(filesDir, 't.md')
    const promptFile = path.join(filesDir, 'p.md')
    const peerTask = path.join(filesDir, 'rev-t.md')
    const peerPrompt = path.join(filesDir, 'rev-p.md')
    for (const f of [taskFile, promptFile, peerTask, peerPrompt]) fs.writeFileSync(f, 'x')
    const file = path.join(tmp, 'ns', 'ws-kgvd-col0', 'dispatch-registry.json')
    saveRegistry(file, {
      entries: [
        {
          taskId: 'task-sup-col0',
          beadId: 'bead-kgvd-col0',
          pane: 'surface:sup-old',
          worktree: process.cwd(),
          role: 'test-supervisor',
          model: '',
          taskFile,
          resultFile: path.join(filesDir, 'r.md'),
          digestFile: path.join(filesDir, 'd.digest'),
          promptFile,
          status: 'spawned',
          submitStatus: 'none',
          callerSurface: 'surface:orch',
          startCommit: 'aaa1111',
          createdAt: '2026-09-14T10:00:00.000Z',
          layoutColumn: 0,
        },
        {
          taskId: 'task-rev-col1',
          beadId: 'bead-kgvd-col0',
          pane: 'surface:rev-live',
          worktree: process.cwd(),
          role: 'code-reviewer',
          model: '',
          taskFile: peerTask,
          resultFile: path.join(filesDir, 'rr.md'),
          digestFile: path.join(filesDir, 'rd.digest'),
          promptFile: peerPrompt,
          status: 'spawned',
          submitStatus: 'none',
          callerSurface: 'surface:orch',
          startCommit: 'aaa1111',
          createdAt: '2026-09-14T11:00:00.000Z',
          layoutColumn: 1,
        },
      ],
    })
    setCmuxAdapterForTests({
      callerSurface: () => 'surface:orch',
      async identify() { return { workspaceId: 'ws-kgvd-col0' } },
      async newSplit() { return { surface: 'surface:sup-new' } },
      async send() {},
      async closeSurface() {},
      async readScreen() { return 'user@host ~/proj $\n' },
    })
    const { pi, cwd, branch } = makePi({ beadId: 'bead-kgvd-col0' })
    const result = await followupVisibleDispatch(pi as any, { beadId: 'bead-kgvd-col0', role: 'test-supervisor', task: 'respawn after col0 gone' }, workflowCtx(cwd, 'bead-kgvd-col0', branch, 'aaa1111'))
    expect(result.status).toBe('spawned')
    expect(findRegistryByTaskId('task-sup-col0')?.entry.pane).toBe('surface:sup-new')
    expect(findRegistryByTaskId('task-sup-col0')?.entry.layoutColumn).toBe(1)
  })

  it('close_visible_dispatch closes both agent panes for bead', async () => {
    const promptA = path.join(tmp, 'pa.md')
    const promptB = path.join(tmp, 'pb.md')
    const taskA = path.join(tmp, 'ta.md')
    const taskB = path.join(tmp, 'tb.md')
    for (const f of [promptA, promptB, taskA, taskB]) fs.writeFileSync(f, 'x')
    const file = path.join(tmp, 'ns', 'ws-kgvd-close', 'dispatch-registry.json')
    saveRegistry(file, {
      entries: [
        {
          taskId: 'task-sup-close',
          beadId: 'bead-close-dual',
          pane: 'surface:sup',
          worktree: tmp,
          role: 'test-supervisor',
          model: '',
          taskFile: taskA,
          resultFile: path.join(tmp, 'ra.md'),
          digestFile: path.join(tmp, 'da.digest'),
          promptFile: promptA,
          status: 'spawned',
          createdAt: 't1',
        },
        {
          taskId: 'task-rev-close',
          beadId: 'bead-close-dual',
          pane: 'surface:rev',
          worktree: tmp,
          role: 'code-reviewer',
          model: '',
          taskFile: taskB,
          resultFile: path.join(tmp, 'rb.md'),
          digestFile: path.join(tmp, 'db.digest'),
          promptFile: promptB,
          status: 'spawned',
          createdAt: 't2',
        },
      ],
    })
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-kgvd-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-close-dual', status: 'closed' })
    const result = await closeVisibleDispatch(pi as any, { beadId: 'bead-close-dual' })
    expect(result.status).toBe('closed')
    expect(closed.sort()).toEqual(['surface:rev', 'surface:sup'].sort())
    expect(findRegistryByTaskId('task-sup-close')?.entry.status).toBe('tombstone')
    expect(findRegistryByTaskId('task-rev-close')?.entry.status).toBe('tombstone')
  })

  it('docs mention resolveVisibleSplitPlacement and 2-column down-stack layout', () => {
    const agents = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8')
    const skill = fs.readFileSync(path.join(process.cwd(), '.pi/skills/dispatch-supervisor/SKILL.md'), 'utf8')
    const review = fs.readFileSync(path.join(process.cwd(), '.pi/skills/review-bead/SKILL.md'), 'utf8')
    const transport = fs.readFileSync(path.join(process.cwd(), '.pi/extensions/beads-dispatch/cmux-transport.ts'), 'utf8')
    expect(transport).toContain('resolveVisibleSplitPlacement')
    expect(agents).toContain('resolveVisibleSplitPlacement')
    expect(agents).toContain('side-by-side')
    expect(agents).toContain('new-split down')
    expect(agents).toContain('оркестратор')
    expect(agents).not.toContain('Geometry 1/2 layout is a separate concern (evxj)')
    expect(agents).not.toContain('no hard N=2 cap')
    expect(skill).toContain('resolveVisibleSplitPlacement')
    expect(skill).toContain('side-by-side')
    expect(review).toContain('resolveVisibleSplitPlacement')
    expect(review).toContain('side-by-side')
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
    expect(skill).toContain('STOP close')
    expect(review).toContain('close_visible_dispatch')
    expect(review).toContain('Do not `close_visible_dispatch` while pending-fix')
    expect(review).toContain('STOP close')
    expect(agents).toContain('close-surface')
    expect(agents).toContain('close_visible_dispatch')
    expect(agents).toContain('pending-fix')
    expect(agents).toContain('STOP close')
    expect(agents).toContain('stopClose')
  })

  it('reviewed+stopClose closes panes and keeps isolation files', async () => {
    const files = seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-a', status: 'reviewed' })
    const result = await closeVisibleDispatch(pi as any, { beadId: 'bead-a', stopClose: true })
    expect(result.status).toBe('closed')
    expect(closed).toEqual(['surface:99'])
    expect(result.tombstoned).toEqual(['task-ld67'])
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('tombstone')
    expect(fs.existsSync(files.promptFile)).toBe(true)
    expect(fs.existsSync(files.taskFile)).toBe(true)
    expect(fs.existsSync(files.resultFile)).toBe(true)
    expect(fs.existsSync(files.digestFile)).toBe(true)
  })

  it('reviewed without stopClose throws not terminal', async () => {
    seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-a', status: 'reviewed' })
    await expect(closeVisibleDispatch(pi as any, { beadId: 'bead-a' })).rejects.toThrow(/not terminal/)
    expect(closed).toEqual([])
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('spawned')
  })

  it('in_progress+stopClose throws BLOCKED', async () => {
    seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-a', status: 'in_progress' })
    await expect(closeVisibleDispatch(pi as any, { beadId: 'bead-a', stopClose: true })).rejects.toThrow(/stopClose requires status=reviewed/)
    expect(closed).toEqual([])
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('spawned')
  })

  it('pendingFix wins over stopClose and skips close', async () => {
    seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const { pi } = makePi({ beadId: 'bead-a', status: 'reviewed' })
    const result = await closeVisibleDispatch(pi as any, { beadId: 'bead-a', pendingFix: true, stopClose: true })
    expect(result.status).toBe('skipped')
    expect(closed).toEqual([])
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('spawned')
  })

  it('closed after stopClose unlinks leftover isolation files', async () => {
    const files = seed()
    const closed: string[] = []
    setCmuxAdapterForTests({
      async identify() { return { workspaceId: 'ws-close' } },
      async newSplit() { return { surface: 'surface:x' } },
      async send() {},
      async closeSurface(surface) { closed.push(surface) },
      async readScreen() { return '' },
    })
    const reviewedPi = makePi({ beadId: 'bead-a', status: 'reviewed' })
    await closeVisibleDispatch(reviewedPi.pi as any, { beadId: 'bead-a', stopClose: true })
    expect(fs.existsSync(files.promptFile)).toBe(true)
    expect(findRegistryByTaskId('task-ld67')?.entry.status).toBe('tombstone')

    const closedPi = makePi({ beadId: 'bead-a', status: 'closed' })
    const result = await closeVisibleDispatch(closedPi.pi as any, { beadId: 'bead-a' })
    expect(result.status).toBe('noop')
    expect(result.text).toMatch(/leftover tombstones/)
    expect(fs.existsSync(files.promptFile)).toBe(false)
    expect(fs.existsSync(files.taskFile)).toBe(false)
    expect(fs.existsSync(files.resultFile)).toBe(false)
    expect(fs.existsSync(files.digestFile)).toBe(false)
  })
})

describe('findLiveSupervisorSpawnsForWorktree', () => {
  let tmp: string
  let worktree: string
  const prevOrch = process.env.ORCH_ROOT

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3o7e-spawns-'))
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), '3o7e-wt-'))
    process.env.ORCH_ROOT = tmp
  })

  afterEach(() => {
    if (prevOrch === undefined) delete process.env.ORCH_ROOT
    else process.env.ORCH_ROOT = prevOrch
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(worktree, { recursive: true, force: true })
  })

  function seed(ns: string, entries: Array<Record<string, unknown>>) {
    const file = path.join(tmp, 'ns', ns, 'dispatch-registry.json')
    saveRegistry(file, { entries: entries as any })
    return file
  }

  function supervisorEntry(overrides: Record<string, unknown> = {}) {
    return {
      taskId: 'task-1',
      beadId: 'bead-a',
      pane: 'surface:1',
      worktree,
      role: 'test-supervisor',
      model: '',
      taskFile: path.join(tmp, 't.md'),
      resultFile: path.join(tmp, 'r.md'),
      digestFile: path.join(tmp, 'd.digest'),
      promptFile: path.join(tmp, 'p.md'),
      status: 'spawned',
      createdAt: 't',
      ...overrides,
    }
  }

  it('returns live supervisor rows matching the worktree realpath', () => {
    seed('ws-1', [supervisorEntry()])
    const matches = findLiveSupervisorSpawnsForWorktree(worktree)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.beadId).toBe('bead-a')
  })

  it('ignores tombstone and hung rows', () => {
    seed('ws-1', [
      supervisorEntry({ taskId: 'task-t', status: 'tombstone' }),
      supervisorEntry({ taskId: 'task-h', hung: true }),
    ])
    expect(findLiveSupervisorSpawnsForWorktree(worktree)).toEqual([])
  })

  it('ignores non-supervisor roles and foreign worktrees', () => {
    seed('ws-1', [
      supervisorEntry({ taskId: 'task-r', role: 'code-reviewer' }),
      supervisorEntry({ taskId: 'task-f', worktree: path.join(tmp, 'other-wt') }),
    ])
    expect(findLiveSupervisorSpawnsForWorktree(worktree)).toEqual([])
  })

  it('skips a corrupt registry file and still returns matches from other ns dirs', () => {
    seed('ws-good', [supervisorEntry()])
    const badDir = path.join(tmp, 'ns', 'ws-bad')
    fs.mkdirSync(badDir, { recursive: true })
    fs.writeFileSync(path.join(badDir, 'dispatch-registry.json'), '{not json')
    const matches = findLiveSupervisorSpawnsForWorktree(worktree)
    expect(matches).toHaveLength(1)
  })

  it('returns multiple rows of the same bead and rows across bead ids for the policy to disambiguate', () => {
    seed('ws-1', [supervisorEntry({ taskId: 'task-1' })])
    seed('ws-2', [
      supervisorEntry({ taskId: 'task-2' }),
      supervisorEntry({ taskId: 'task-3', beadId: 'bead-b' }),
    ])
    const matches = findLiveSupervisorSpawnsForWorktree(worktree)
    expect(matches).toHaveLength(3)
  })

  it('returns empty for missing ns root and empty worktree path', () => {
    expect(findLiveSupervisorSpawnsForWorktree(worktree)).toEqual([])
    seed('ws-1', [supervisorEntry()])
    expect(findLiveSupervisorSpawnsForWorktree('')).toEqual([])
  })
})

function unquoteChildPrompt(cmd: string): string {
  const prefix = 'pi --approve -- '
  if (!cmd.startsWith(prefix)) throw new Error(`unexpected child command: ${cmd}`)
  const quoted = cmd.slice(prefix.length)
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) throw new Error(`prompt is not posix-quoted: ${quoted}`)
  return quoted.slice(1, -1).replace(/'\\''/g, "'")
}

describe('spawn_task_workspace helpers', () => {
  it('validates title as exactly 2–3 words without · suffix', () => {
    expect(validateTaskWorkspaceTitle('Видимый reviewer')).toBeUndefined()
    expect(validateTaskWorkspaceTitle('a b c')).toBeUndefined()
    expect(validateTaskWorkspaceTitle('one')).toMatch(/2–3/)
    expect(validateTaskWorkspaceTitle('one two three four')).toMatch(/2–3/)
    expect(validateTaskWorkspaceTitle('Видимый reviewer · 0lp7')).toMatch(/suffix/)
  })

  it('builds workspace name with · suffix and child command without pi --name', () => {
    expect(buildTaskWorkspaceName('Видимый reviewer', 'beads-task-issue-tracker-0lp7')).toBe('Видимый reviewer · 0lp7')
    const cmd = buildTaskWorkspaceChildCommand('beads-task-issue-tracker-0lp7')
    expect(cmd.startsWith('pi --approve -- ')).toBe(true)
    expect(cmd).not.toMatch(/pi --name/)
    expect(cmd).toContain('0lp7')
    expect(cmd).toContain('Возьми')
    expect(cmd).toContain('Работаю автономно')
    expect(cmd).not.toContain('cmux send')
  })

  it('inlines a two-step parent ping only when both identify refs are present', () => {
    const hinted = buildTaskWorkspaceChildCommand('beads-task-issue-tracker-0lp7', undefined, {
      workspaceRef: 'workspace:34',
      surface: 'surface:orch',
    })
    const prompt = unquoteChildPrompt(hinted)
    expect(hinted.startsWith('pi --approve -- ')).toBe(true)
    expect(hinted).not.toMatch(/pi --name/)
    expect(prompt).toContain('Возьми beads-task-issue-tracker-0lp7')
    expect(prompt).toContain('Работаю автономно')
    expect(prompt).toContain('plan-review')
    expect(prompt).toContain('не жди выбора плана')
    expect(prompt).toContain('Не проси перезапуск Pi')
    expect(prompt).toContain('из worktree')
    expect(prompt).toContain('cmux send --workspace workspace:34 --surface surface:orch --')
    expect(prompt).toContain('В текст send подставь фактический SHA коммита и номер PR')
    expect(prompt).toContain('значения <SHA> и <номер> замени до отправки')
    expect(prompt).toContain('Текст send не должен содержать \\n или \\r')
    expect(prompt).not.toContain('без Enter')
    expect(prompt).not.toContain('реальный коммит')
    expect(prompt).not.toContain('шаблон')
    const sendBody = prompt.match(/cmux send --workspace \S+ --surface \S+ -- '([^']*)'/)
    expect(sendBody?.[1]).toBe('merge готов, <SHA>, PR #<номер>')
    expect(sendBody?.[1]).not.toBe('merge готов, реальный коммит и номер PR, не шаблон')
    expect(prompt).toContain('sleep 1')
    expect(prompt).toContain('cmux send-key --workspace workspace:34 --surface surface:orch enter')
    expect(prompt.length).toBeLessThan(2000)
    expect(prompt).not.toContain('workspace:37')
    expect(prompt).not.toContain('surface:112')

    const workspaceOnly = buildTaskWorkspaceChildCommand('beads-task-issue-tracker-0lp7', '  ', {
      workspaceRef: 'workspace:34',
    })
    expect(unquoteChildPrompt(workspaceOnly)).toContain('Работаю автономно')
    expect(unquoteChildPrompt(workspaceOnly)).not.toContain('cmux send')
    expect(unquoteChildPrompt(workspaceOnly)).not.toContain('surface:')

    const surfaceOnly = buildTaskWorkspaceChildCommand('beads-task-issue-tracker-0lp7', undefined, {
      surface: 'surface:orch',
    })
    expect(unquoteChildPrompt(surfaceOnly)).not.toContain('cmux send')
    expect(unquoteChildPrompt(surfaceOnly)).not.toContain('surface:orch')

    const replaced = buildTaskWorkspaceChildCommand(
      'beads-task-issue-tracker-0lp7',
      '  только явный текст  ',
      { workspaceRef: 'workspace:34', surface: 'surface:orch' },
    )
    expect(unquoteChildPrompt(replaced)).toBe('только явный текст')
    expect(replaced).not.toContain('Работаю автономно')
    expect(replaced).not.toContain('cmux send')
  })

  it('builds new-workspace argv with focus false and optional group', () => {
    const withGroup = buildNewWorkspaceArgv({
      name: 'T · x',
      cwd: '/repo',
      command: "pi --approve -- 'hi'",
      focus: false,
      groupId: 'group:1',
      groupPlacement: 'afterCurrent',
      groupReference: 'workspace:34',
    })
    expect(withGroup).toEqual(expect.arrayContaining(['new-workspace', '--focus', 'false', '--cwd', '/repo', '--group', 'group:1', '--group-placement', 'afterCurrent', '--group-reference', 'workspace:34']))
    const bare = buildNewWorkspaceArgv({ name: 'T · x', cwd: '/repo', command: 'pi --approve -- x', focus: false })
    expect(bare).not.toContain('--group')
    expect(bare).toContain('--focus')
    expect(bare).toContain('false')
  })

  it('picks color skipping parent and extracts group only when present', () => {
    expect(pickTaskWorkspaceColor({ parentColor: 'Indigo' })).toBe('Teal')
    expect(pickTaskWorkspaceColor({ explicit: 'Purple', parentColor: 'Indigo' })).toBe('Purple')
    expect(pickTaskWorkspaceColor({ parentColor: '#283593' })).toBe('Teal')
    expect(extractWorkspaceGroupId({ ref: 'workspace:1' })).toBeUndefined()
    expect(extractWorkspaceGroupId({ group_id: 'group:9' })).toBe('group:9')
    expect(extractWorkspaceGroupId({ group: { ref: 'group:2' } })).toBe('group:2')
  })

  it('resolves main checkout from git-common-dir and SPAWN_LOCK stale rules', () => {
    expect(mainCheckoutFromGitCommonDir('/Users/x/Projects/repo/.git')).toBe('/Users/x/Projects/repo')
    const fresh = isSpawnLockBlocking(
      [{ text: 'SPAWN_LOCK bead-a\ncreatedAt: 2099-01-01T00:00:00.000Z\nstatus: pending\nparentWorkspace: workspace:1' }],
      'bead-a',
      Date.parse('2099-01-01T00:01:00.000Z'),
    )
    expect(fresh.blocked).toBe(true)
    const stale = isSpawnLockBlocking(
      [{ text: 'SPAWN_LOCK bead-a\ncreatedAt: 2000-01-01T00:00:00.000Z\nstatus: pending' }],
      'bead-a',
      Date.parse('2000-01-01T01:00:00.000Z'),
    )
    expect(stale.blocked).toBe(false)
    expect(stale.stale).toBe(true)
  })
})

describe('spawn_task_workspace tool', () => {
  const beadId = 'beads-task-issue-tracker-abc1'
  const parentBead = 'beads-task-issue-tracker-hy3z'
  const mainCwd = '/Users/test/Projects/beads-task-issue-tracker'
  const hy3zCwd = '/Users/test/Projects/worktrees/beads-task-issue-tracker/hy3z-workflow-spawn-task-workspace'

  function makeSpawnPi(opts: {
    status?: string
    comments?: Array<{ text?: string }>
    groupId?: string
    parentColor?: string | null
    cmuxFail?: string
    createStdout?: string
    surfaceRef?: string | null
  } = {}) {
    const cmuxCalls: string[][] = []
    const bdCalls: string[][] = []
    const pi = {
      exec: async (command: string, args: string[]) => {
        if (command === 'bd') {
          bdCalls.push(args)
          if (args[0] === 'show') {
            return { code: 0, stdout: JSON.stringify([{ id: beadId, title: 'Target title', status: opts.status ?? 'open' }]), stderr: '' }
          }
          if (args[0] === 'comments' && args[1] === beadId && !args.includes('add')) {
            return { code: 0, stdout: JSON.stringify(opts.comments ?? []), stderr: '' }
          }
          if (args[0] === 'comments' && args.includes('add')) {
            return { code: 0, stdout: 'ok', stderr: '' }
          }
          return { code: 0, stdout: '[]', stderr: '' }
        }
        if (command === 'git') {
          if (args.includes('--git-common-dir')) {
            return { code: 0, stdout: `${mainCwd}/.git\n`, stderr: '' }
          }
          return { code: 0, stdout: `${hy3zCwd}\n`, stderr: '' }
        }
        if (command === 'cmux') {
          cmuxCalls.push(args)
          if (opts.cmuxFail === args[0] || (opts.cmuxFail === 'identify' && args[0] === 'identify')) {
            return { code: 1, stdout: '', stderr: 'cmux down' }
          }
          if (args[0] === 'identify') {
            const caller: Record<string, string> = { workspace_ref: 'workspace:34' }
            if (opts.surfaceRef !== null) caller.surface_ref = opts.surfaceRef ?? 'surface:orch'
            return {
              code: 0,
              stdout: JSON.stringify({ caller }),
              stderr: '',
            }
          }
          if (args[0] === 'workspace' && args[1] === 'list') {
            const row: Record<string, unknown> = {
              ref: 'workspace:34',
              custom_color: opts.parentColor ?? null,
              title: 'Parent',
            }
            if (opts.groupId) row.group_id = opts.groupId
            return { code: 0, stdout: JSON.stringify({ workspaces: [row] }), stderr: '' }
          }
          if (args[0] === 'new-workspace') {
            if (opts.cmuxFail === 'new-workspace-group' && args.includes('--group')) {
              return { code: 1, stdout: '', stderr: 'group missing' }
            }
            return { code: 0, stdout: opts.createStdout ?? 'OK workspace:99', stderr: '' }
          }
          if (args[0] === 'workspace-action') return { code: 0, stdout: '#283593', stderr: '' }
          if (args[0] === 'reorder-workspace') return { code: 0, stdout: 'index=4', stderr: '' }
          if (args[0] === 'list-pane-surfaces') {
            return {
              code: 0,
              stdout: JSON.stringify({
                workspace_ref: 'workspace:99',
                surfaces: [{ ref: 'surface:500', type: 'terminal', selected: true, title: 'π - x' }],
              }),
              stderr: '',
            }
          }
          if (args[0] === 'tab-action') return { code: 0, stdout: 'OK', stderr: '' }
          if (args[0] === 'close-workspace') return { code: 0, stdout: 'OK', stderr: '' }
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      registerTool() {},
      events: { emit() {} },
    }
    return { pi, cmuxCalls, bdCalls }
  }

  function ctx(activeBead = parentBead, hasUI = true) {
    return {
      cwd: hy3zCwd,
      hasUI,
      sessionManager: {
        getEntries: () => [
          { type: 'custom', customType: 'workflow-state', data: { activeBead, branch: 'feat/hy3z', worktreePath: hy3zCwd } },
        ],
      },
    }
  }

  it('dryRun plans focus false, main cwd, · suffix name, pi --approve, set-color, surface rename', async () => {
    const { pi, cmuxCalls } = makeSpawnPi()
    const result = await spawnTaskWorkspace(
      pi as any,
      { beadId, title: 'Параллельный reviewer', dryRun: true },
      ctx(),
    )
    expect(result.status).toBe('dry-run')
    expect(result.mainCwd).toBe(mainCwd)
    expect(result.mainCwd).not.toContain('hy3z')
    expect(result.workspaceName).toBe('Параллельный reviewer · abc1')
    const flat = (result.argvPlan ?? []).flat().join(' ')
    expect(flat).toContain('--focus false')
    expect(flat).toContain(`--cwd ${mainCwd}`)
    expect(flat).toContain('Параллельный reviewer · abc1')
    expect(flat).toContain('pi --approve --')
    expect(flat).not.toContain('pi --name')
    expect(flat).toContain('set-color')
    expect(flat).toContain('--surface')
    expect(flat).toContain('--workspace')
    expect(flat).toContain('workspace:NEW')
    expect(flat).toContain(ORCHESTRATOR_TAB_TITLE)
    const dryRename = (result.argvPlan ?? []).find((row) => row[0] === 'tab-action') ?? []
    expect(dryRename).toContain('--surface')
    expect(dryRename).toContain('--workspace')
    expect(dryRename).toContain('workspace:NEW')
    expect(result.text).toMatch(/set-color|argv/)
    const child = (result.argvPlan ?? []).find((row) => row[0] === 'new-workspace')?.find((part) => part.startsWith('pi --approve --')) ?? ''
    const prompt = unquoteChildPrompt(child)
    expect(prompt).toContain('Работаю автономно')
    expect(prompt).toContain('workspace:34')
    expect(prompt).toContain('surface:orch')
    expect(prompt).toContain('cmux send --workspace workspace:34 --surface surface:orch')
    expect(prompt).toContain('sleep 1')
    expect(prompt).toContain('cmux send-key')
    // dryRun may identify for group/color context but must not create
    expect(cmuxCalls.some((c) => c[0] === 'new-workspace')).toBe(false)
  })

  it('dryRun without identify does not invent a parent surface or cmux send', async () => {
    const offline = makeSpawnPi({ cmuxFail: 'identify' })
    const failedIdentify = await spawnTaskWorkspace(
      offline.pi as any,
      { beadId, title: 'Два слова', dryRun: true },
      ctx(),
    )
    const failedChild = (failedIdentify.argvPlan ?? []).find((row) => row[0] === 'new-workspace')?.find((part) => part.startsWith('pi --approve --')) ?? ''
    expect(unquoteChildPrompt(failedChild)).toContain('Работаю автономно')
    expect(unquoteChildPrompt(failedChild)).not.toContain('cmux send')
    expect(unquoteChildPrompt(failedChild)).not.toContain('surface:')

    const headless = makeSpawnPi()
    const noUi = await spawnTaskWorkspace(
      headless.pi as any,
      { beadId, title: 'Два слова', dryRun: true },
      ctx(parentBead, false),
    )
    const noUiChild = (noUi.argvPlan ?? []).find((row) => row[0] === 'new-workspace')?.find((part) => part.startsWith('pi --approve --')) ?? ''
    expect(unquoteChildPrompt(noUiChild)).not.toContain('cmux send')
    expect(headless.cmuxCalls.some((c) => c[0] === 'identify')).toBe(false)
    expect(headless.cmuxCalls.some((c) => c[0] === 'new-workspace')).toBe(false)
  })

  it('live spawn without parent surface does not create a workspace', async () => {
    const { pi, cmuxCalls, bdCalls } = makeSpawnPi({ surfaceRef: null })
    await expect(spawnTaskWorkspace(pi as any, { beadId, title: 'Два слова' }, ctx())).rejects.toThrow(/surface|BLOCKED/)
    expect(cmuxCalls.some((c) => c[0] === 'identify')).toBe(true)
    expect(cmuxCalls.some((c) => c[0] === 'new-workspace')).toBe(false)
    expect(bdCalls.some((c) => c.includes('add'))).toBe(false)
  })

  it('mock group id uses --group afterCurrent; without group uses reorder --after', async () => {
    const withGroup = makeSpawnPi({ groupId: 'group:7' })
    const grouped = await spawnTaskWorkspace(
      withGroup.pi as any,
      { beadId, title: 'Два слова', dryRun: true },
      ctx(),
    )
    const gCreate = grouped.argvPlan?.[0] ?? []
    expect(gCreate).toContain('--group')
    expect(gCreate).toContain('group:7')
    expect(gCreate).toContain('afterCurrent')
    expect(grouped.argvPlan?.some((row) => row[0] === 'reorder-workspace')).toBe(false)

    const noGroup = makeSpawnPi()
    const bare = await spawnTaskWorkspace(
      noGroup.pi as any,
      { beadId, title: 'Два слова', dryRun: true },
      ctx(),
    )
    expect(bare.argvPlan?.[0] ?? []).not.toContain('--group')
    expect(bare.argvPlan?.some((row) => row.includes('--after'))).toBe(true)
  })

  it('live spawn creates workspace, sets color, renames surface, writes SPAWN_LOCK', async () => {
    const { pi, cmuxCalls, bdCalls } = makeSpawnPi()
    const result = await spawnTaskWorkspace(
      pi as any,
      { beadId, title: 'Два слова' },
      ctx(),
    )
    expect(result.status).toBe('spawned')
    expect(result.workspaceRef).toBe('workspace:99')
    expect(result.surface).toBe('surface:500')
    expect(cmuxCalls.some((c) => c[0] === 'new-workspace' && c.includes('--focus') && c.includes('false'))).toBe(true)
    expect(cmuxCalls.some((c) => c[0] === 'workspace-action' && c.includes('set-color'))).toBe(true)
    expect(cmuxCalls.some((c) => c[0] === 'tab-action' && c.includes('--surface') && c.includes(ORCHESTRATOR_TAB_TITLE))).toBe(true)
    expect(cmuxCalls.some((c) =>
      c[0] === 'tab-action'
      && c.includes('--surface')
      && c.includes('surface:500')
      && c.includes('--workspace')
      && c.includes('workspace:99')
      && c.includes(ORCHESTRATOR_TAB_TITLE),
    )).toBe(true)
    expect(cmuxCalls.some((c) => c[0] === 'tab-action' && c.includes('--workspace') && !c.includes('--surface'))).toBe(false)
    expect(result.renameWarning).toBeUndefined()
    const lockAdds = bdCalls.filter((c) => c[0] === 'comments' && c.includes('add'))
    expect(lockAdds.some((c) => String(c[c.length - 1]).includes('SPAWN_LOCK'))).toBe(true)
  })

  it('BLOCKS own bead, busy status, SPAWN_LOCK, missing cmux, bad title', async () => {
    const own = makeSpawnPi()
    await expect(spawnTaskWorkspace(own.pi as any, { beadId: parentBead, title: 'Два слова' }, ctx(parentBead))).rejects.toThrow(/свой active bead|BLOCKED/)

    const busy = makeSpawnPi({ status: 'in_progress' })
    await expect(spawnTaskWorkspace(busy.pi as any, { beadId, title: 'Два слова' }, ctx())).rejects.toThrow(/in_progress|BLOCKED/)

    const locked = makeSpawnPi({
      comments: [{ text: `SPAWN_LOCK ${beadId}\ncreatedAt: ${new Date().toISOString()}\nstatus: pending\nparentWorkspace: workspace:1` }],
    })
    await expect(spawnTaskWorkspace(locked.pi as any, { beadId, title: 'Два слова' }, ctx())).rejects.toThrow(/SPAWN_LOCK|BLOCKED/)

    const noCmux = makeSpawnPi({ cmuxFail: 'identify' })
    await expect(spawnTaskWorkspace(noCmux.pi as any, { beadId, title: 'Два слова' }, ctx())).rejects.toThrow(/cmux|BLOCKED/)

    const badTitle = makeSpawnPi()
    await expect(spawnTaskWorkspace(badTitle.pi as any, { beadId, title: 'одно' }, ctx())).rejects.toThrow(/2–3|BLOCKED/)
  })

  it('group create fail retries once without group', async () => {
    const { pi, cmuxCalls } = makeSpawnPi({ groupId: 'group:9', cmuxFail: 'new-workspace-group' })
    const result = await spawnTaskWorkspace(pi as any, { beadId, title: 'Два слова' }, ctx())
    expect(result.status).toBe('spawned')
    expect(result.groupUsed).toBe(false)
    const creates = cmuxCalls.filter((c) => c[0] === 'new-workspace')
    expect(creates.length).toBeGreaterThanOrEqual(2)
    expect(creates[0]).toContain('--group')
    expect(creates[creates.length - 1]).not.toContain('--group')
  })

  it('registers spawn_task_workspace tool on extension load', () => {
    const tools: Array<{ name: string }> = []
    beadsDispatchExtension({
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      registerTool: (tool: any) => tools.push(tool),
      events: { emit() {} },
    } as any)
    expect(tools.some((t) => t.name === 'spawn_task_workspace')).toBe(true)
  })

  it('set-color argv builder pins workspace-action shape', () => {
    expect(buildSetWorkspaceColorArgv('workspace:99', 'Indigo')).toEqual([
      'workspace-action',
      '--workspace',
      'workspace:99',
      '--action',
      'set-color',
      '--color',
      'Indigo',
    ])
    expect(buildCmuxRenameArgv('surface:500', ORCHESTRATOR_TAB_TITLE)).toEqual([
      'tab-action',
      '--action',
      'rename',
      '--surface',
      'surface:500',
      '--title',
      ORCHESTRATOR_TAB_TITLE,
      '--focus',
      'false',
    ])
    expect(buildCmuxRenameArgv('surface:500', ORCHESTRATOR_TAB_TITLE, 'workspace:99')).toEqual([
      'tab-action',
      '--action',
      'rename',
      '--surface',
      'surface:500',
      '--title',
      ORCHESTRATOR_TAB_TITLE,
      '--focus',
      'false',
      '--workspace',
      'workspace:99',
    ])
  })
})
