import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import beadsDispatchExtension, { PLAN_APPROVED_READINESS_MATRIX, chooseSupervisor, extractPlanSupervisorAgent, nsDir, parseVisiblePing, setCmuxAdapterForTests, setSpawnForDispatchTestOverride, supervisorArtifactReadyForReview, validateSupervisorReadiness } from '../../.pi/extensions/beads-dispatch/index'
import { clearObservedDashboardCards, createDashboardState, getSharedDashboardState, registerDashboardRenderer, resetDashboardWidgetHost, selectDashboardAgents, setSharedDashboardState } from '../../.pi/extensions/subagent/dashboard'

const plan = `PLAN APPROVED
Approved-by: Test
Approved-at: 2026-05-10T00:00:00Z
Start-commit: 68241c7309542b76eff49c3360514fb4110f0a83
Problem:
- Need deterministic path rules.
Approach:
- Load path rules.
Rejected alternatives:
- Mock-only tests.
Files to change:
- src-tauri/src/lib.rs
Acceptance:
- PATH_RULES_LOADED includes matching rules.
Verification / acceptance checks:
- Vitest dry run verifies sentinel.`


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

describe('supervisorArtifactReadyForReview', () => {
  const start = 'c38915a51df6d6baa533d5e6504ecb1c4a9fd21b'
  const end = 'c0e73d258a52dd2e5696459fb7a51c917a656da5'
  const base = `SUPERVISOR ARTIFACT\n- Status: DONE\n- Artifact status: complete\n- Commit: ${end}`

  it('accepts Verification with exit 0 (ednj live wording)', () => {
    const output = `${base}\n- Verification: git diff --check exit 0; rg marker exit 0`
    expect(supervisorArtifactReadyForReview({ exitCode: 0, output }, start, end)).toBe(true)
  })

  it('still accepts Verification with exit code 0', () => {
    const output = `${base}\n- Verification: pnpm test exit code 0, output excerpt: passed`
    expect(supervisorArtifactReadyForReview({ exitCode: 0, output }, start, end)).toBe(true)
  })

  it('rejects Verification N/A', () => {
    const output = `${base}\n- Verification: N/A`
    expect(supervisorArtifactReadyForReview({ exitCode: 0, output }, start, end)).toBe(false)
  })
})

function createSuccessfulSpawn(stdoutLine = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPERVISOR ARTIFACT\n- Status: DONE' }], usage: { input: 1, output: 1, totalTokens: 2 }, model: 'test-model' } }) + '\n') {
  return (() => {
    const proc: any = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => true
    queueMicrotask(() => {
      proc.stdout.write(stdoutLine)
      proc.stdout.end()
      proc.stderr.end()
      proc.emit('close', 0)
    })
    return proc
  }) as any
}

let unregisterRenderer: (() => void) | undefined

beforeEach(() => {
  setSpawnForDispatchTestOverride(null)
  setCmuxAdapterForTests(null)
  unregisterRenderer?.()
  unregisterRenderer = undefined
  clearObservedDashboardCards()
  setSharedDashboardState(null)
  resetDashboardWidgetHost()
})

afterEach(() => {
  setSpawnForDispatchTestOverride(null)
  setCmuxAdapterForTests(null)
  unregisterRenderer?.()
  clearObservedDashboardCards()
  setSharedDashboardState(null)
  resetDashboardWidgetHost()
})

function validBead(descriptionText = description(['.pi/extensions/beads-dispatch/index.ts'])) {
  return { id: 'bead-current', status: 'in_progress', labels: ['pi', 'workflow'], description: descriptionText }
}

function workflowCtx(cwd: string, beadId: string, branch: string, startCommit: string) {
  return {
    cwd,
    sessionManager: {
      getEntries: () => [{ type: 'custom', customType: 'workflow-state', data: { activeBead: beadId, branch, worktreePath: cwd, startCommit, sessionKey: 'session:test' } }],
    },
  }
}

function currentBranch(cwd = process.cwd()) {
  return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim() || 'task/current'
}

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

/** Full handoff without rust/cargo/src-tauri tokens. Role-words must live in description (and title); do not reuse description() which embeds src-tauri. */
function roleWordsHandoffDescription() {
  return `### Origin
- Prose mentions vue/tauri/test-supervisor role names only.
### Files
- .pi/extensions/beads-dispatch/index.ts
### Current state
- chooseSupervisor misroutes on bare tauri in role words.
### Target state
- Role words vue-supervisor / tauri-supervisor / test-supervisor do not select tauri-supervisor.
### Investigation findings
- Bare tauri substring in prose selected tauri-supervisor for pi+workflow beads.
### Decisions
- Drop bare tauri from first regex; keep backend/tracker labels and real backend path/tooling signals.
### Rejected alternatives
- Labels-only routing without text signals.
### Dependencies / blockers
- none.
### Acceptance criteria
- dryRun without agent= returns test-supervisor for this fixture.
### Verification / acceptance checks
- pnpm exec vitest run tests/extensions/beads-dispatch.test.ts
### Out of scope
- vue false-positive routing.`
}

function srcTauriFilesHandoffDescription() {
  return roleWordsHandoffDescription().replace(
    '- .pi/extensions/beads-dispatch/index.ts',
    '- src-tauri/src/lib.rs',
  )
}

function planApprovedWithSupervisor(name?: string) {
  return name ? `${currentPlan}\nSupervisor: ${name}` : currentPlan
}

async function dryRunDispatchSupervisor(opts: {
  beadId: string
  description: string
  planText: string
  agent?: string
  title?: string
  labels?: string[]
}) {
  let registeredTool: any
  const branch = currentBranch()
  const pi = {
    events: { emit() {} },
    registerTool(tool: any) {
      if (tool.name === 'dispatch_supervisor') registeredTool = tool
    },
    exec: async (command: string, args: string[]) => {
      if (command === 'bd' && args[0] === 'show') {
        return {
          stdout: JSON.stringify({
            id: opts.beadId,
            title: opts.title ?? 'qhdt plan supervisor autodispatch fixture',
            status: 'in_progress',
            labels: opts.labels ?? ['pi', 'workflow'],
            description: opts.description,
          }),
          stderr: '',
          code: 0,
        }
      }
      if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: opts.planText }]), stderr: '', code: 0 }
      if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
      if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
      if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    },
  }
  beadsDispatchExtension(pi as any)
  const params: { beadId: string; dryRun: true; agent?: string } = { beadId: opts.beadId, dryRun: true }
  if (opts.agent) params.agent = opts.agent
  return registeredTool.execute('call-1', params, undefined, undefined, workflowCtx(process.cwd(), opts.beadId, branch, 'abc1234'))
}

describe('beads-dispatch path rules integration', () => {
  it('routes main-start dispatch dryRun to structured task worktree from workflow-state', async () => {
    let registeredTool: any
    const execCalls: Array<{ command: string; args: string[] }> = []
    const taskWorktree = process.cwd()
    const branch = execFileSync('git', ['-C', taskWorktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim() || process.env.GITHUB_HEAD_REF || 'task/current'
    const mainCwd = path.dirname(process.cwd())
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'in_progress', labels: ['dx'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${mainCwd} branch --show-current`) return { stdout: 'main\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${mainCwd} rev-parse --show-toplevel`) return { stdout: `${mainCwd}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${taskWorktree} branch --show-current`) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${taskWorktree} rev-parse --show-toplevel`) return { stdout: `${taskWorktree}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === `-C ${taskWorktree} rev-parse HEAD`) return { stdout: 'task-head\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, {
      cwd: mainCwd,
      sessionManager: {
        getEntries: () => [{ type: 'custom', customType: 'workflow-state', data: { activeBead: 'bead-a', branch, worktreePath: taskWorktree, startCommit: 'task-head', sessionKey: 'session:test' } }],
      },
    })

    expect(result.details.worktreePath).toBe(taskWorktree)
    expect(execCalls).toContainEqual({ command: 'git', args: ['-C', taskWorktree, 'branch', '--show-current'] })
  })

  it('includes src-tauri/PI_RULES.md in supervisor dryRun prompts for src-tauri targets', async () => {
    let registeredTool: any
    const branch = currentBranch()
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'in_progress', labels: ['dx'], description: description(['src-tauri/src/lib.rs']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(process.cwd(), 'bead-a', branch, 'abc1234'))

    expect(result.details.output).toContain('PATH_RULES_LOADED:')
    expect(result.details.output).toContain('--- src-tauri/PI_RULES.md')
    expect(result.details.output).not.toContain('--- src-tauri/CLAUDE.md')
    expect(result.details.output).toContain('# src-tauri/ — Rust backend')
  })

  it('passes a temporary real-codebase PI_RULES.md sentinel through dispatch dryRun and removes probes', async () => {
    let registeredTool: any
    const probeDir = `.tmp-dispatch-rules-probe-${Date.now()}`
    const sentinel = `DISPATCH_SENTINEL_${Date.now()}`
    const branch = currentBranch()
    const absoluteDir = path.join(process.cwd(), probeDir)
    await fs.mkdir(absoluteDir)

    try {
      await fs.writeFile(path.join(absoluteDir, 'PI_RULES.md'), `# Dispatch probe\n${sentinel}\n`)
      await fs.writeFile(path.join(absoluteDir, 'feature.ts'), 'export const feature = true\n')
      const pi = {
        events: { emit() {} },
        registerTool(tool: any) {
          if (tool.name === 'dispatch_supervisor') registeredTool = tool
        },
        exec: async (command: string, args: string[]) => {
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-probe', status: 'in_progress', labels: ['dx'], description: description([`${probeDir}/feature.ts`]) }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: plan }]), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
          if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
          if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 0 }
        },
      }

      beadsDispatchExtension(pi as any)
      const result = await registeredTool.execute('call-1', { beadId: 'bead-probe', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(process.cwd(), 'bead-probe', branch, 'abc1234'))

      expect(result.details.output).toContain('PATH_RULES_LOADED:')
      expect(result.details.output).toContain(`--- ${probeDir}/PI_RULES.md`)
      expect(result.details.output).toContain(sentinel)
    } finally {
      await fs.rm(absoluteDir, { recursive: true, force: true })
    }

    await expect(fs.stat(absoluteDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})


describe('beads-dispatch wrapper workflow boundary', () => {
  it('supervisor prompt makes typed workflow preflight and submit wrapper-owned', async () => {
    let registeredTool: any
    const branch = currentBranch()
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-wrapper', status: 'in_progress', labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: `${currentPlan}\nLegacy supervisor-side note:\n- Supervisor should call workflow_status before implementation and workflow_submit_for_review after commit.` }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-wrapper', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(process.cwd(), 'bead-wrapper', branch, 'abc1234'))
    const output = result.details.output

    expect(output).toContain('WRAPPER WORKFLOW BOUNDARY:')
    expect(output).toContain('dispatch_supervisor already performed typed workflow preflight')
    expect(output).toContain('Do not call or depend on workflow_status')
    expect(output).toContain('wrapper/orchestrator owns review-transition routing')
    expect(output).toContain('- Commit: <sha or not committed with reason>')
  })

  it('submits for review from wrapper when supervisor returns a complete artifact with a new commit', async () => {
    let registeredTool: any
    const events: Array<{ name: string, event: any }> = []
    const execCalls: Array<{ command: string, args: string[] }> = []
    const cwd = process.cwd()
    const branch = currentBranch(cwd)
    let showCount = 0
    setSpawnForDispatchTestOverride(createSuccessfulSpawn(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPERVISOR ARTIFACT\n- Status: DONE\n- Verification: pnpm test exit code 0, output excerpt: passed\n- Commit: def5678\n- Artifact status: complete' }], usage: { input: 1, output: 1, totalTokens: 2 }, model: 'test-model' } }) + '\n'))
    const pi = {
      events: { emit(name: string, event: any) { events.push({ name, event }) } },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') {
          showCount++
          const status = showCount >= 3 ? 'inreview' : 'in_progress'
          return { stdout: JSON.stringify({ id: 'bead-submit', status, labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'update') return { stdout: JSON.stringify({ id: 'bead-submit', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : (execCalls.filter((call) => call.command === 'git' && call.args.includes('HEAD')).length > 1 ? 'def5678\n' : 'abc1234\n'), stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-submit', dryRun: false, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, 'bead-submit', branch, 'abc1234'))

    expect(result.details.endCommit).toBe('def5678')
    expect(execCalls).toContainEqual({ command: 'bd', args: ['update', 'bead-submit', '--status', 'inreview', '--json'] })
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && call.args[3]?.includes('WORKFLOW SUBMIT FOR REVIEW'))).toBe(true)
    expect(events.at(-1)?.event).toMatchObject({ state: 'inreview', sessionMode: 'inreview', endCommit: 'def5678' })
  })

  it('fails fast before spawn when workflow-state scope is absent or mismatched', async () => {
    let registeredTool: any
    let spawnCount = 0
    setSpawnForDispatchTestOverride((() => {
      spawnCount++
      return createSuccessfulSpawn()()
    }) as any)
    const branch = currentBranch()
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    }

    beadsDispatchExtension(pi as any)
    const missing = await registeredTool.execute('missing', { beadId: 'bead-preflight', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, { cwd: process.cwd() })
    const mismatched = await registeredTool.execute('mismatch', { beadId: 'bead-preflight', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(process.cwd(), 'other-bead', branch, 'abc1234'))
    const missingStart = await registeredTool.execute('missing-start', { beadId: 'bead-preflight', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, {
      cwd: process.cwd(),
      sessionManager: { getEntries: () => [{ type: 'custom', customType: 'workflow-state', data: { activeBead: 'bead-preflight', branch, worktreePath: process.cwd(), sessionKey: 'session:test' } }] },
    })

    expect(missing.details.error).toContain('active task bead отсутствует')
    expect(mismatched.details.error).toContain('active bead mismatch')
    expect(missingStart.details.error).toContain('recorded START_COMMIT отсутствует')
    expect(spawnCount).toBe(0)
  })

  it('fails fast before spawn when workflow-state start commit is stale', async () => {
    let registeredTool: any
    let spawnCount = 0
    const cwd = process.cwd()
    const branch = currentBranch(cwd)
    setSpawnForDispatchTestOverride((() => {
      spawnCount++
      return createSuccessfulSpawn()()
    }) as any)
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : 'actual-head\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const stale = await registeredTool.execute('stale', { beadId: 'bead-preflight', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, 'bead-preflight', branch, 'recorded-start'))

    expect(stale.details.error).toContain('recorded START_COMMIT stale')
    expect(spawnCount).toBe(0)
  })

  it('does not submit for review when supervisor artifact omits commit evidence', async () => {
    let registeredTool: any
    const events: Array<{ name: string, event: any }> = []
    const execCalls: Array<{ command: string, args: string[] }> = []
    const cwd = process.cwd()
    const branch = currentBranch(cwd)
    setSpawnForDispatchTestOverride(createSuccessfulSpawn(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPERVISOR ARTIFACT\n- Status: DONE\n- Verification: pnpm test exit code 0, output excerpt: passed\n- Artifact status: complete' }], usage: { input: 1, output: 1, totalTokens: 2 }, model: 'test-model' } }) + '\n'))
    const pi = {
      events: { emit(name: string, event: any) { events.push({ name, event }) } },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args })
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-incomplete', status: 'in_progress', labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'update') return { stdout: JSON.stringify({ id: 'bead-incomplete', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : (execCalls.filter((call) => call.command === 'git' && call.args.includes('HEAD')).length > 1 ? 'def5678\n' : 'abc1234\n'), stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-incomplete', dryRun: false, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, 'bead-incomplete', branch, 'abc1234'))

    expect(result.details.endCommit).toBe('def5678')
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'update')).toBe(false)
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && call.args[3]?.includes('WORKFLOW SUBMIT FOR REVIEW'))).toBe(false)
    expect(events.at(-1)?.event).toMatchObject({ state: 'implementing', sessionMode: 'implementing', endCommit: 'def5678' })
  })
})


describe('beads-dispatch supervisor execution contract', () => {
  it('publishes registered dispatch_supervisor successful lifecycle cards and repaints an open dashboard', async () => {
    let registeredTool: any
    let repaintCount = 0
    const cwd = process.cwd()
    const branch = currentBranch(cwd)
    const state = createDashboardState(selectDashboardAgents([{ name: 'test-supervisor', description: 'Test supervisor', source: 'project' }], { teams: [], warnings: [] }), 'active')
    setSharedDashboardState(state)
    unregisterRenderer = registerDashboardRenderer({ requestRender: () => repaintCount++ })
    setSpawnForDispatchTestOverride(createSuccessfulSpawn())
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-dashboard', status: 'in_progress', labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-dashboard', dryRun: false, agent: 'test-supervisor', transport: 'headless' }, undefined, undefined, workflowCtx(cwd, 'bead-dashboard', branch, 'abc1234'))

    expect(result.details.exitCode).toBe(0)
    expect(getSharedDashboardState()?.cards.get('test-supervisor')?.status).toBe('completed')
    expect(repaintCount).toBeGreaterThan(0)
  })

  it('auto-shows headless dispatch cards from a null dashboard store', async () => {
    let registeredTool: any
    const cwd = process.cwd()
    const branch = currentBranch(cwd)
    expect(getSharedDashboardState()).toBeNull()
    setSpawnForDispatchTestOverride(createSuccessfulSpawn())
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-auto-show', status: 'in_progress', labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute(
      'call-1',
      { beadId: 'bead-auto-show', dryRun: false, agent: 'test-supervisor', transport: 'headless' },
      undefined,
      undefined,
      workflowCtx(cwd, 'bead-auto-show', branch, 'abc1234'),
    )

    expect(result.details.exitCode).toBe(0)
    const shared = getSharedDashboardState()
    expect(shared?.visible).toBe(true)
    expect(shared?.origin).toBe('auto')
    expect(shared?.mode).toBe('active')
    expect(shared?.cards.get('test-supervisor')?.status).toBe('completed')
  })

  it('does not publish a TUI dashboard card for transport=cmux visible spawn', async () => {
    let registeredTool: any
    const cwd = process.cwd()
    const branch = currentBranch(cwd)
    const head = 'abc1234'
    const workspaceId = `ws-cmux-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const registryDir = nsDir(workspaceId)
    const registryFile = path.join(registryDir, 'dispatch-registry.json')
    const clearRegistry = async () => {
      await fs.mkdir(registryDir, { recursive: true })
      await fs.writeFile(registryFile, JSON.stringify({ entries: [] }, null, 2), 'utf8')
    }
    await clearRegistry()
    try {
      setCmuxAdapterForTests({
        identify: async () => ({ workspaceId, surface: 'surface:orch' }),
        newSplit: async () => ({ surface: 'surface:child' }),
        send: async () => undefined,
        readScreen: async () => 'ready',
        closeSurface: async () => undefined,
        renameSurface: async () => undefined,
      })
      const pi = {
        events: { emit() {} },
        registerTool(tool: any) {
          if (tool.name === 'dispatch_supervisor') registeredTool = tool
        },
        exec: async (command: string, args: string[]) => {
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-cmux-card', status: 'in_progress', labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
          if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
          if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : `${head}\n`, stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 0 }
        },
      }

      beadsDispatchExtension(pi as any)
      const result = await registeredTool.execute(
        'call-1',
        { beadId: 'bead-cmux-card', transport: 'cmux', agent: 'test-supervisor' },
        undefined,
        undefined,
        workflowCtx(cwd, 'bead-cmux-card', branch, head),
      )

      expect(result.details.transport).toBe('cmux')
      expect(result.details.error).toBeUndefined()
      expect(getSharedDashboardState()).toBeNull()
    } finally {
      await clearRegistry()
      await fs.rm(registryDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('renders execution contract sections with explicit N/A compatibility defaults', async () => {
    let registeredTool: any
    const branch = currentBranch()
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-contract', status: 'in_progress', labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-contract', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(process.cwd(), 'bead-contract', branch, 'abc1234'))
    const output = result.details.output

    expect(output).toContain('EXECUTION CONTRACT:')
    expect(output).toContain('Write zone:')
    expect(output).toContain('- .pi/extensions/beads-dispatch/index.ts')
    expect(output).toContain('Do not touch:')
    expect(output).toContain('- Running a real subagent.')
    expect(output).toContain('Sibling streams:\nN/A')
    expect(output).toContain('Stop rules:')
    expect(output).toContain('Verification:')
    expect(output).toContain('- pnpm test -- tests/extensions/beads-dispatch.test.ts exits 0.')
    expect(output).toContain('SUPERVISOR ARTIFACT:')
    expect(output).toContain('- Artifact status: <complete | incomplete, with reason if incomplete>')
  })

  it('documents the execution contract in dispatch skill and agent docs', async () => {
    const dispatchSkill = await fs.readFile(path.join(process.cwd(), '.pi/skills/dispatch-supervisor/SKILL.md'), 'utf8')
    const agentDocs = await fs.readFile(path.join(process.cwd(), '.pi/agents/README.md'), 'utf8')
    const docs = `${dispatchSkill}\n${agentDocs}`

    for (const heading of ['Write zone', 'Do not touch', 'Sibling streams', 'Stop rules', 'Verification', 'SUPERVISOR ARTIFACT']) {
      expect(docs).toContain(heading)
    }
    expect(docs).toContain('explicit `N/A`')
  })
})


describe('beads-dispatch PLAN APPROVED readiness contract', () => {
  it('accepts the current plan-bead auto-execute contract with START_COMMIT alias and Plan intent', () => {
    expect(validateSupervisorReadiness(validBead(), [{ text: currentPlan }])).toEqual([])
  })

  it('accepts the legacy dispatch contract with Start-commit and Problem/Approach intent', () => {
    expect(validateSupervisorReadiness(validBead(), [{ text: plan }])).toEqual([])
  })

  it('rejects incomplete PLAN APPROVED comments with actionable missing-field messages', () => {
    const errors = validateSupervisorReadiness(validBead(), [{ text: 'PLAN APPROVED\nApproved-by: Test' }])

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Approved-at (Approved-at:)')
    expect(errors[0]).toContain('Start commit (Start-commit: or START_COMMIT:)')
    expect(errors[0]).toContain('Files to change (Files to change:)')
    expect(errors[0]).toContain('Acceptance (Acceptance:)')
    expect(errors[0]).toContain('Verification / acceptance checks (Verification / acceptance checks:)')
    expect(errors[0]).toContain('Implementation intent (Plan: or Problem: + Approach:)')
  })

  it('ignores later BLOCKED/hook text that only mentions PLAN APPROVED as a substring', () => {
    const blockedHook =
      'BLOCKED: runtime hook missing\n\nPLAN APPROVED записан, но child cwd остаётся main.\nRecovery: re-dispatch after hook fix.'
    const errors = validateSupervisorReadiness(validBead(), [
      { text: currentPlan },
      { text: blockedHook },
    ])

    expect(errors.filter((error) => error.includes('в PLAN APPROVED comment отсутствуют fields:'))).toEqual([])
    expect(errors).toEqual([])
  })

  it('treats BLOCKED-only comments with PLAN APPROVED substring as missing the plan marker', () => {
    const blockedOnly =
      'BLOCKED: runtime hook missing\n\nPLAN APPROVED записан earlier, but this comment is not a plan.'
    const errors = validateSupervisorReadiness(validBead(), [{ text: blockedOnly }])

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('в PLAN APPROVED comment отсутствуют fields:')
    expect(errors[0]).toContain('PLAN APPROVED')
  })

  it('accepts PLAN APPROVED after leading blank lines or markdown heading on the first non-empty line', () => {
    const withBlanks = `\n\n${currentPlan}`
    const withHeading = currentPlan.replace(/^PLAN APPROVED/, '## PLAN APPROVED')

    expect(validateSupervisorReadiness(validBead(), [{ text: withBlanks }])).toEqual([])
    expect(validateSupervisorReadiness(validBead(), [{ text: withHeading }])).toEqual([])
  })

  it('ignores later DISPATCH comments that embed PLAN APPROVED only in the body prompt', () => {
    const dispatchWithEmbeddedPlan =
      `DISPATCH (test-supervisor)\n\nBRANCH: fix/rb7o\n\nPrompt follows:\n${currentPlan}\n\nEnd prompt.`
    const errors = validateSupervisorReadiness(validBead(), [
      { text: currentPlan },
      { text: dispatchWithEmbeddedPlan },
    ])

    expect(errors).toEqual([])
  })

  it('keeps plan-bead and dispatch-supervisor docs synchronized with the readiness matrix aliases', async () => {
    const planSkill = await fs.readFile(path.join(process.cwd(), '.pi/skills/plan-bead/SKILL.md'), 'utf8')
    const dispatchSkill = await fs.readFile(path.join(process.cwd(), '.pi/skills/dispatch-supervisor/SKILL.md'), 'utf8')
    const docs = `${planSkill}\n${dispatchSkill}`

    expect(docs).toContain(PLAN_APPROVED_READINESS_MATRIX.marker)
    for (const field of PLAN_APPROVED_READINESS_MATRIX.fields) {
      for (const alias of field.aliases) expect(docs).toContain(alias)
    }
    expect(docs).toContain('Plan:')
    expect(docs).toContain('Problem:')
    expect(docs).toContain('Approach:')
    for (const field of PLAN_APPROVED_READINESS_MATRIX.acceptedContextFields) {
      expect(docs).toContain(field)
    }
  })

  it('headless dryRun reports resolved model from project agent-models.json', async () => {
    let registeredTool: any
    const branch = currentBranch()
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-model', status: 'in_progress', labels: ['pi'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }
    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-model', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(process.cwd(), 'bead-model', branch, 'abc1234'))
    expect(result.details.model).toBe('xai/grok-4.6')
    expect(result.content[0].text).toContain('model=xai/grok-4.6')
    expect(result.content[0].text).toContain('thinking=medium')
  })

  it('headless dryRun reports resolved thinking including explicit off', async () => {
    const cwd = process.cwd()
    const branch = currentBranch(cwd)
    const modelsPath = path.join(cwd, '.pi', 'agent-models.json')
    const originalModels = await fs.readFile(modelsPath, 'utf8')
    let registeredTool: any
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-think', status: 'in_progress', labels: ['pi'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }
    try {
      const parsed = JSON.parse(originalModels)
      parsed.classThinking = { ...(parsed.classThinking || {}), standard: 'high' }
      await fs.writeFile(modelsPath, JSON.stringify(parsed, null, 2))
      beadsDispatchExtension(pi as any)
      const high = await registeredTool.execute('call-1', { beadId: 'bead-think', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, 'bead-think', branch, 'abc1234'))
      expect(high.details.thinking).toBe('high')
      expect(high.content[0].text).toContain('thinking=high')

      parsed.classThinking.standard = 'off'
      await fs.writeFile(modelsPath, JSON.stringify(parsed, null, 2))
      const off = await registeredTool.execute('call-2', { beadId: 'bead-think', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, 'bead-think', branch, 'abc1234'))
      expect(off.details.thinking).toBe('off')
      expect(off.content[0].text).toContain('thinking=off')
    } finally {
      await fs.writeFile(modelsPath, originalModels)
    }
  })

  it('headless spawn argv includes --model when class resolves and omits it when empty', async () => {
    const cwd = process.cwd()
    const branch = currentBranch(cwd)
    const modelsPath = path.join(cwd, '.pi', 'agent-models.json')
    const originalModels = await fs.readFile(modelsPath, 'utf8')

    const captured: string[][] = []
    setSpawnForDispatchTestOverride(((command: string, args: string[]) => {
      captured.push(args)
      const proc: any = new EventEmitter()
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = () => true
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPERVISOR ARTIFACT\n- Status: DONE\n- Verification: skip exit code 0\n- Commit: abc\n- Artifact status: complete' }], usage: { input: 1, output: 1, totalTokens: 2 }, model: 'xai/grok-4.5' } }) + '\n')
        proc.stdout.end()
        proc.stderr.end()
        proc.emit('close', 0)
      })
      return proc
    }) as any)

    let registeredTool: any
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-argv', status: 'in_progress', labels: ['pi'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'update') return { stdout: JSON.stringify({ id: 'bead-argv', status: 'inreview' }), stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    try {
      beadsDispatchExtension(pi as any)
      await registeredTool.execute('call-1', { beadId: 'bead-argv', dryRun: false, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, 'bead-argv', branch, 'abc1234'))
      expect(captured.length).toBeGreaterThan(0)
      const spawnArgs = captured[0]
      expect(spawnArgs).toBeDefined()
      expect(spawnArgs!).toContain('--model')
      expect(spawnArgs![spawnArgs!.indexOf('--model') + 1]).toBe('xai/grok-4.6')
      expect(spawnArgs!).toContain('--thinking')
      expect(spawnArgs![spawnArgs!.indexOf('--thinking') + 1]).toBe('medium')

      // With class thinking high → --thinking high
      const withThinking = JSON.parse(originalModels)
      withThinking.classThinking = { standard: 'high' }
      await fs.writeFile(modelsPath, JSON.stringify(withThinking, null, 2))
      captured.length = 0
      await registeredTool.execute('call-think', { beadId: 'bead-argv', dryRun: false, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, 'bead-argv', branch, 'abc1234'))
      expect(captured.length).toBeGreaterThan(0)
      expect(captured[0]).toContain('--thinking')
      expect(captured[0]![captured[0]!.indexOf('--thinking') + 1]).toBe('high')

      // Empty classes → inherit (no --model / no --thinking)
      await fs.writeFile(modelsPath, JSON.stringify({ classes: {}, roles: {}, agentClasses: {} }, null, 2))
      captured.length = 0
      await registeredTool.execute('call-2', { beadId: 'bead-argv', dryRun: false, agent: 'test-supervisor' }, undefined, undefined, workflowCtx(cwd, 'bead-argv', branch, 'abc1234'))
      expect(captured.length).toBeGreaterThan(0)
      expect(captured[0]).not.toContain('--model')
      expect(captured[0]).not.toContain('--thinking')
    } finally {
      await fs.writeFile(modelsPath, originalModels)
    }
  })
})

describe('extractPlanSupervisorAgent', () => {
  it('returns the Supervisor field from the latest PLAN APPROVED comment', () => {
    expect(extractPlanSupervisorAgent([{ text: planApprovedWithSupervisor('test-supervisor') }])).toBe('test-supervisor')
  })

  it('returns undefined when PLAN APPROVED has no Supervisor field', () => {
    expect(extractPlanSupervisorAgent([{ text: currentPlan }])).toBeUndefined()
  })

  it('returns undefined when there is no PLAN APPROVED comment', () => {
    expect(extractPlanSupervisorAgent([{ text: 'ordinary comment without a plan marker' }])).toBeUndefined()
    expect(extractPlanSupervisorAgent([])).toBeUndefined()
  })

  it('uses the latest PLAN APPROVED comment; a newer plan without the field wins over an older one with it', () => {
    expect(extractPlanSupervisorAgent([
      { text: planApprovedWithSupervisor('test-supervisor') },
      { text: planApprovedWithSupervisor('vue-supervisor') },
    ])).toBe('vue-supervisor')
    expect(extractPlanSupervisorAgent([
      { text: planApprovedWithSupervisor('test-supervisor') },
      { text: currentPlan },
    ])).toBeUndefined()
  })

  it('rejects garbage that is not [a-z0-9-]+ and keeps regex prefix semantics', () => {
    expect(extractPlanSupervisorAgent([{ text: `${currentPlan}\nSupervisor: Not An Agent!!` }])).toBeUndefined()
    // Prefix-only capture: [a-z0-9-]+ stops at the space, so `Supervisor: test supervisor` → `test`.
    expect(extractPlanSupervisorAgent([{ text: `${currentPlan}\nSupervisor: test supervisor` }])).toBe('test')
  })
})

describe('chooseSupervisor', () => {
  it('does not pick tauri-supervisor from role-words in title+description with pi+workflow labels', () => {
    // Negative: prose about vue/tauri/test-supervisor must not force tauri path without rust context.
    expect(chooseSupervisor({
      id: 've9e-role-words',
      title: 'vue/tauri/test-supervisor role words in title',
      description: roleWordsHandoffDescription(),
      labels: ['pi', 'workflow'],
      status: 'in_progress',
    })).toBe('test-supervisor')
  })

  it('picks tauri-supervisor for backend label without rust text', () => {
    expect(chooseSupervisor({
      id: 've9e-backend',
      title: 'Backend command tweak',
      description: 'No path hints here.',
      labels: ['backend'],
      status: 'in_progress',
    })).toBe('tauri-supervisor')
  })

  it('picks tauri-supervisor when description mentions src-tauri without backend label', () => {
    expect(chooseSupervisor({
      id: 've9e-src-tauri',
      title: 'Path touch',
      description: 'Edit src-tauri/src/lib.rs only.',
      labels: ['pi'],
      status: 'in_progress',
    })).toBe('tauri-supervisor')
  })

  it('picks test-supervisor for hy3z-like pi+workflow handoff with src-tauri only in Out of scope', () => {
    // textForSupervisorRouting strips ### Out of scope; title has no rust tokens; do not reuse description().
    const description = roleWordsHandoffDescription().replace(
      /### Out of scope\n[\s\S]*$/,
      '### Out of scope\n- src-tauri\n- app/',
    )
    expect(chooseSupervisor({
      id: '0nvj-hy3z-like',
      title: 'hy3z-like pi workflow routing',
      description,
      labels: ['pi', 'workflow'],
      status: 'in_progress',
    })).toBe('test-supervisor')
  })

  it('picks test-supervisor when Не трогать block sits outside an Out of scope heading', () => {
    const description = `${roleWordsHandoffDescription()}\n\nНе трогать:\n- src-tauri/\n- app/`
    expect(chooseSupervisor({
      id: '0nvj-ne-trogat',
      title: 'negation block outside heading',
      description,
      labels: ['pi', 'workflow'],
      status: 'in_progress',
    })).toBe('test-supervisor')
  })

  it('picks test-supervisor for do not touch and don\'t touch openers', () => {
    const doNotTouch = `${roleWordsHandoffDescription()}\n\ndo not touch:\n- src-tauri/`
    const dontTouch = `${roleWordsHandoffDescription()}\n\n- don't touch src-tauri/`
    expect(chooseSupervisor({
      id: '0nvj-do-not-touch',
      title: 'do not touch opener',
      description: doNotTouch,
      labels: ['pi', 'workflow'],
      status: 'in_progress',
    })).toBe('test-supervisor')
    expect(chooseSupervisor({
      id: '0nvj-dont-touch',
      title: 'dont touch list opener',
      description: dontTouch,
      labels: ['pi', 'workflow'],
      status: 'in_progress',
    })).toBe('test-supervisor')
  })

  it('picks tauri-supervisor when title contains src-tauri even if description is clean', () => {
    expect(chooseSupervisor({
      id: '0nvj-title-src-tauri',
      title: 'chooseSupervisor: src-tauri in title stays a tauri signal',
      description: roleWordsHandoffDescription(),
      labels: ['pi', 'workflow'],
      status: 'in_progress',
    })).toBe('tauri-supervisor')
  })

  it('picks tauri-supervisor when Files lists src-tauri even if Out of scope also mentions it', () => {
    const description = roleWordsHandoffDescription()
      .replace('- .pi/extensions/beads-dispatch/index.ts', '- src-tauri/src/lib.rs')
      .replace(
        /### Out of scope\n[\s\S]*$/,
        '### Out of scope\n- documentation-only notes.',
      )
    expect(chooseSupervisor({
      id: '0nvj-files-and-oos',
      title: 'mixed files and out of scope',
      description,
      labels: ['pi', 'workflow'],
      status: 'in_progress',
    })).toBe('tauri-supervisor')
  })

  it('dryRun without agent= uses chooseSupervisor on role-words handoff fixture → test-supervisor', async () => {
    // Separate dryRun fixture: do not reuse description() (it embeds src-tauri and would force tauri-supervisor).
    // Role-words must appear in description; title-only would still work via text concat, but empty/missing desc is a vacuum case.
    let registeredTool: any
    const branch = currentBranch()
    const title = 'vue/tauri/test-supervisor role words dryRun'
    const handoff = roleWordsHandoffDescription()
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') {
          return {
            stdout: JSON.stringify({
              id: 'bead-role-words',
              title,
              status: 'in_progress',
              labels: ['pi', 'workflow'],
              description: handoff,
            }),
            stderr: '',
            code: 0,
          }
        }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }
    beadsDispatchExtension(pi as any)
    // No agent= — auto-pick via chooseSupervisor.
    const result = await registeredTool.execute('call-1', { beadId: 'bead-role-words', dryRun: true }, undefined, undefined, workflowCtx(process.cwd(), 'bead-role-words', branch, 'abc1234'))
    expect(result.details.error).toBeUndefined()
    expect(result.details.agent).toBe('test-supervisor')
  })

  it('N15 dryRun with explicit agent= documentation-expert does not consult the routing table', async () => {
    let registeredTool: any
    const branch = currentBranch()
    const title = 'vue/tauri/test-supervisor role words dryRun override'
    const handoff = roleWordsHandoffDescription()
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') {
          return {
            stdout: JSON.stringify({
              id: 'bead-role-words-override',
              title,
              status: 'in_progress',
              labels: ['backend', 'tracker'],
              description: handoff,
            }),
            stderr: '',
            code: 0,
          }
        }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: `${branch}\n`, stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }
    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-role-words-override', dryRun: true, agent: 'documentation-expert' }, undefined, undefined, workflowCtx(process.cwd(), 'bead-role-words-override', branch, 'abc1234'))
    expect(result.details.error).toBeUndefined()
    expect(result.details.agent).toBe('documentation-expert')
    expect(result.details.routingWarning).toBeUndefined()
  })

  it('dryRun PLAN APPROVED Supervisor: test-supervisor beats src-tauri Files routing', async () => {
    const result = await dryRunDispatchSupervisor({
      beadId: 'bead-qhdt-plan-supervisor',
      description: srcTauriFilesHandoffDescription(),
      planText: planApprovedWithSupervisor('test-supervisor'),
    })
    expect(result.details.error).toBeUndefined()
    expect(result.details.agent).toBe('test-supervisor')
  })

  it('dryRun same src-tauri Files bead without Supervisor field → tauri-supervisor', async () => {
    const result = await dryRunDispatchSupervisor({
      beadId: 'bead-qhdt-no-supervisor-field',
      description: srcTauriFilesHandoffDescription(),
      planText: currentPlan,
    })
    expect(result.details.error).toBeUndefined()
    expect(result.details.agent).toBe('tauri-supervisor')
  })

  it('dryRun missing PLAN APPROVED Supervisor agent falls back to table with routingWarning', async () => {
    const result = await dryRunDispatchSupervisor({
      beadId: 'bead-qhdt-missing-agent',
      description: srcTauriFilesHandoffDescription(),
      planText: planApprovedWithSupervisor('nonexistent-supervisor'),
    })
    expect(result.details.error).toBeUndefined()
    expect(result.details.agent).toBe('tauri-supervisor')
    expect(result.details.routingWarning).toContain('nonexistent-supervisor')
  })

  it('dryRun explicit agent= overrides PLAN APPROVED Supervisor field', async () => {
    const result = await dryRunDispatchSupervisor({
      beadId: 'bead-qhdt-agent-override',
      description: srcTauriFilesHandoffDescription(),
      planText: planApprovedWithSupervisor('test-supervisor'),
      agent: 'tauri-supervisor',
    })
    expect(result.details.error).toBeUndefined()
    expect(result.details.agent).toBe('tauri-supervisor')
    expect(result.details.routingWarning).toBeUndefined()
  })
})

describe('parseVisiblePing', () => {
  it('parses [PING] taskId= and задача id forms', () => {
    const withEquals = parseVisiblePing('[PING] test-supervisor · задача task-abc завершена taskId=task-abc digest=x')
    expect(withEquals).toMatchObject({ kind: 'ok', taskId: 'task-abc', missingId: false })

    const zadachaOnly = parseVisiblePing('[PING-ERROR] code-reviewer · задача task-xyz: boom')
    expect(zadachaOnly).toMatchObject({ kind: 'error', taskId: 'task-xyz', missingId: false })
  })

  it('marks missing id and ignores non-ping text', () => {
    expect(parseVisiblePing('[PING] finished without markers')).toMatchObject({ kind: 'ok', missingId: true })
    expect(parseVisiblePing('ordinary chat about ping protocol')).toBeUndefined()
  })
})
