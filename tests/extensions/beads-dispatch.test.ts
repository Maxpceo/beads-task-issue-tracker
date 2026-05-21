import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import beadsDispatchExtension, { PLAN_APPROVED_READINESS_MATRIX, validateSupervisorReadiness } from '../../.pi/extensions/beads-dispatch/index'

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
    const branch = execFileSync('git', ['-C', taskWorktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
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
        if (command === 'git' && args.join(' ') === `-C ${taskWorktree} branch --show-current`) return { stdout: 'task/current\n', stderr: '', code: 0 }
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
