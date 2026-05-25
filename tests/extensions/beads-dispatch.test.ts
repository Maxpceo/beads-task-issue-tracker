import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import beadsDispatchExtension, { PLAN_APPROVED_READINESS_MATRIX, setSpawnForDispatchTestOverride, validateSupervisorReadiness } from '../../.pi/extensions/beads-dispatch/index'
import { clearObservedDashboardCards, createDashboardState, getSharedDashboardState, registerDashboardRenderer, selectDashboardAgents, setSharedDashboardState } from '../../.pi/extensions/subagent/dashboard'

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
  unregisterRenderer?.()
  unregisterRenderer = undefined
  clearObservedDashboardCards()
  setSharedDashboardState(null)
})

afterEach(() => {
  setSpawnForDispatchTestOverride(null)
  unregisterRenderer?.()
  clearObservedDashboardCards()
  setSharedDashboardState(null)
})

function validBead(descriptionText = description(['.pi/extensions/beads-dispatch/index.ts'])) {
  return { id: 'bead-current', status: 'in_progress', labels: ['pi', 'workflow'], description: descriptionText }
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
        getEntries: () => [{ type: 'custom', customType: 'workflow-state', data: { activeBead: 'bead-a', branch, worktreePath: taskWorktree, sessionKey: 'session:test' } }],
      },
    })

    expect(result.details.worktreePath).toBe(taskWorktree)
    expect(execCalls).toContainEqual({ command: 'git', args: ['-C', taskWorktree, 'branch', '--show-current'] })
  })

  it('includes src-tauri/CLAUDE.md in supervisor dryRun prompts for src-tauri targets', async () => {
    let registeredTool: any
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'in_progress', labels: ['dx'], description: description(['src-tauri/src/lib.rs']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: 'feature/path-rules\n', stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, { cwd: process.cwd() })

    expect(result.details.output).toContain('PATH_RULES_LOADED:')
    expect(result.details.output).toContain('--- src-tauri/CLAUDE.md')
    expect(result.details.output).toContain('# src-tauri/ — Rust backend')
  })

  it('passes a temporary real-codebase PI_RULES.md sentinel through dispatch dryRun and removes probes', async () => {
    let registeredTool: any
    const probeDir = `.tmp-dispatch-rules-probe-${Date.now()}`
    const sentinel = `DISPATCH_SENTINEL_${Date.now()}`
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
          if (command === 'git' && args.includes('branch')) return { stdout: 'feature/path-rules\n', stderr: '', code: 0 }
          if (command === 'git' && args.includes('rev-parse')) return { stdout: 'abc1234\n', stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 0 }
        },
      }

      beadsDispatchExtension(pi as any)
      const result = await registeredTool.execute('call-1', { beadId: 'bead-probe', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, { cwd: process.cwd() })

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
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-wrapper', status: 'in_progress', labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: `${currentPlan}\nLegacy supervisor-side note:\n- Supervisor should call workflow_status before implementation and workflow_submit_for_review after commit.` }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: 'fix/wrapper\n', stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-wrapper', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, { cwd: process.cwd() })
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
    let showCount = 0
    setSpawnForDispatchTestOverride(createSuccessfulSpawn(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPERVISOR ARTIFACT\n- Status: DONE\n- Verification: pnpm test exit code 0\n- Artifact status: complete' }], usage: { input: 1, output: 1, totalTokens: 2 }, model: 'test-model' } }) + '\n'))
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
        if (command === 'git' && args.includes('branch')) return { stdout: 'fix/wrapper\n', stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : (execCalls.filter((call) => call.command === 'git' && call.args.includes('HEAD')).length > 1 ? 'def5678\n' : 'abc1234\n'), stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-submit', dryRun: false, agent: 'test-supervisor' }, undefined, undefined, { cwd })

    expect(result.details.endCommit).toBe('def5678')
    expect(execCalls).toContainEqual({ command: 'bd', args: ['update', 'bead-submit', '--status', 'inreview', '--json'] })
    expect(execCalls.some((call) => call.command === 'bd' && call.args[0] === 'comments' && call.args[1] === 'add' && call.args[3]?.includes('WORKFLOW SUBMIT FOR REVIEW'))).toBe(true)
    expect(events.at(-1)?.event).toMatchObject({ state: 'inreview', sessionMode: 'inreview', endCommit: 'def5678' })
  })
})


describe('beads-dispatch supervisor execution contract', () => {
  it('publishes registered dispatch_supervisor successful lifecycle cards and repaints an open dashboard', async () => {
    let registeredTool: any
    let repaintCount = 0
    const cwd = process.cwd()
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
        if (command === 'git' && args.includes('branch')) return { stdout: 'fix/dashboard\n', stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${cwd}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-dashboard', dryRun: false, agent: 'test-supervisor' }, undefined, undefined, { cwd })

    expect(result.details.exitCode).toBe(0)
    expect(getSharedDashboardState()?.cards.get('test-supervisor')?.status).toBe('completed')
    expect(repaintCount).toBeGreaterThan(0)
  })

  it('renders execution contract sections with explicit N/A compatibility defaults', async () => {
    let registeredTool: any
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-contract', status: 'in_progress', labels: ['pi', 'workflow'], description: description(['.pi/extensions/beads-dispatch/index.ts']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: currentPlan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: 'task/contract\n', stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-contract', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, { cwd: process.cwd() })
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
})
