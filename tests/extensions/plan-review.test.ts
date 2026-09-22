import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import planReviewExtension, {
  MAX_PLAN_REVIEW_CYCLES,
  MAX_PLAN_REVIEW_TOTAL_SPAWNS,
  PLAN_REVIEW_WAITING_TRIO_ENTRY,
  PLAN_REVIEW_WAITING_TRIO_NOTICE,
  announceVisiblePlanReviewWait,
  classifyPlanReviewRisk,
  evaluatePlanReviewGate,
  findInvalidSequentialReasons,
  hasImportantOrCriticalFindings,
  missingRevisedPlanSections,
  parsePlanReviewOutput,
  planReviewStopAdvice,
  renderPlanReviewResults,
  runPlanReviewers,
  type PlanReviewResult,
} from '../../.pi/extensions/plan-review/index'
import {
  clearObservedDashboardCards,
  getSharedDashboardState,
  resetDashboardWidgetHost,
  setSharedDashboardState,
} from '../../.pi/extensions/subagent/dashboard'
import type { SpawnSyncVisibleAgentsInput } from '../../.pi/extensions/beads-dispatch/visible-agents'

const tmpDirs: string[] = []

function makeAgentModelsCwd(config: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-agent-models-'))
  tmpDirs.push(root)
  fs.mkdirSync(path.join(root, '.pi'), { recursive: true })
  fs.writeFileSync(path.join(root, '.pi', 'agent-models.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return root
}

const cheapPlanReviewConfig = {
  classes: {
    strong: 'xai/grok-4.6',
    standard: 'xai/grok-4.6',
    cheap: 'xai/grok-4.3',
  },
  roles: {},
  agentClasses: {
    'plan-edge-reviewer': 'cheap',
    'plan-consistency-reviewer': 'cheap',
    'plan-dead-zone-reviewer': 'cheap',
  },
  classThinking: {
    cheap: 'medium',
    strong: 'high',
    standard: 'medium',
  },
}

const approvedReviewText = 'PLAN REVIEW: APPROVED\nFindings:\n- severity: minor\n  issue: none\n  evidence: ok\n  suggested fix: none\nUnresolved blockers: none'

function jsonAssistant(text: string) {
  return {
    code: 0,
    stderr: '',
    stdout: `${JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    })}\n`,
  }
}

beforeEach(() => {
  clearObservedDashboardCards()
  setSharedDashboardState(null)
  resetDashboardWidgetHost()
})

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('plan-review gate helpers', () => {
  it('exports a no-op extension factory for the Pi extension loader', () => {
    expect(typeof planReviewExtension).toBe('function')
    expect(planReviewExtension({} as never)).toBeUndefined()
  })

  it('parses structured reviewer verdicts and findings', () => {
    const result = parsePlanReviewOutput('plan-edge-reviewer', `PLAN REVIEW: NEEDS_CHANGES
Findings:
- severity: important
  issue: Missing rollback for failed reviewer
  evidence: plan says execute after review
  suggested fix: block auto-execute on reviewer failure
Unresolved blockers: none`)

    expect(result).toMatchObject({ reviewer: 'plan-edge-reviewer', verdict: 'NEEDS_CHANGES', unresolvedBlockers: [] })
    expect(result.findings[0]).toMatchObject({ severity: 'important', issue: 'Missing rollback for failed reviewer' })
  })

  it('blocks the gate when a required reviewer is missing or blocked', () => {
    const gate = evaluatePlanReviewGate([
      { reviewer: 'plan-edge-reviewer', verdict: 'APPROVED', findings: [], unresolvedBlockers: [], raw: '' },
      { reviewer: 'plan-consistency-reviewer', verdict: 'BLOCKED', findings: [], unresolvedBlockers: ['missing acceptance'], raw: '' },
    ])

    expect(gate.ok).toBe(false)
    expect(gate.missingReviewers).toEqual(['plan-dead-zone-reviewer'])
    expect(gate.reasons).toEqual(expect.arrayContaining([
      'missing reviewer: plan-dead-zone-reviewer',
      'blocked reviewer: plan-consistency-reviewer',
      'unresolved blocker: plan-consistency-reviewer: missing acceptance',
    ]))
  })

  it('requires revised-plan adjudication sections before auto-execute', () => {
    const missing = missingRevisedPlanSections(`Reviewer findings summary:
- ok
Accepted findings:
- none
Rejected findings:
- none
Unresolved blockers: none
Revised plan:
1. Implement
Files to change:
- .pi/extensions/plan-mode/index.ts
Acceptance:
- tests pass
Risks / rollback:
- revert
`)

    expect(missing).toEqual(['AUTO_EXECUTE_ALLOWED: true'])
  })

  it('rejects vague sequential reasons and accepts whitelisted ones in the matrix', () => {
    const invalidPlan = `| Stream | Goal | Agent | Write zone | Dependencies | Verification | Decision | Reason |
|---|---|---|---|---|---|---|---|
| A | Update docs | docs supervisor | .pi/skills/plan-bead/SKILL.md | none | rg matrix | sequential | files are related |`
    const validPlan = invalidPlan.replace('files are related', 'dependency chain: tests consume the docs contract')
    const invalidRussianPlan = `| Поток | Цель | Агент | Зона изменений | Зависимости | Проверка | Решение | Причина |
|---|---|---|---|---|---|---|---|
| A | Обновить docs | docs supervisor | .pi/skills/plan-bead/SKILL.md | нет | rg matrix | sequential | files are related |`
    const validRussianPlan = invalidRussianPlan.replace('files are related', 'dependency chain: tests consume the docs contract')

    expect(findInvalidSequentialReasons(invalidPlan)).toEqual([
      'Sequential stream row 3 has unsupported reason: files are related',
    ])
    expect(missingRevisedPlanSections(invalidPlan)).toContain('Sequential stream row 3 has unsupported reason: files are related')
    expect(findInvalidSequentialReasons(validPlan)).toEqual([])
    expect(findInvalidSequentialReasons(invalidRussianPlan)).toEqual([
      'Sequential stream row 3 has unsupported reason: files are related',
    ])
    expect(findInvalidSequentialReasons(validRussianPlan)).toEqual([])
  })

  it('exports auto cap 2 and total spawn ceiling 4', () => {
    expect(MAX_PLAN_REVIEW_CYCLES).toBe(2)
    expect(MAX_PLAN_REVIEW_TOTAL_SPAWNS).toBe(4)
  })

  it('planReviewStopAdvice exclusive matrix ignores risk and caps at cycle 2', () => {
    expect(planReviewStopAdvice({ cycle: 1, gateOk: false, hasImportantOrCritical: false })).toBe('HARD_BLOCK')
    expect(planReviewStopAdvice({ cycle: 1, gateOk: false, hasImportantOrCritical: true })).toBe('HARD_BLOCK')
    expect(planReviewStopAdvice({ cycle: 2, gateOk: false, hasImportantOrCritical: true })).toBe('HARD_BLOCK')

    expect(planReviewStopAdvice({ cycle: 1, gateOk: true, hasImportantOrCritical: false })).toBe('STOP_SHOW_USER')
    expect(planReviewStopAdvice({ cycle: 2, gateOk: true, hasImportantOrCritical: false })).toBe('STOP_SHOW_USER')

    expect(planReviewStopAdvice({ cycle: 1, gateOk: true, hasImportantOrCritical: true })).toBe('CONTINUE')
    expect(planReviewStopAdvice({ cycle: 0, gateOk: true, hasImportantOrCritical: true })).toBe('CONTINUE')
    expect(planReviewStopAdvice({ cycle: 2, gateOk: true, hasImportantOrCritical: true })).toBe('STOP_SHOW_USER')
    // Extra cycles 3–4 also STOP_SHOW_USER (never CONTINUE) via cycle >= MAX_PLAN_REVIEW_CYCLES
    expect(planReviewStopAdvice({ cycle: 3, gateOk: true, hasImportantOrCritical: true })).toBe('STOP_SHOW_USER')
    expect(planReviewStopAdvice({ cycle: 4, gateOk: true, hasImportantOrCritical: true })).toBe('STOP_SHOW_USER')
  })

  it('classifyPlanReviewRisk is telemetry-only with FAST_PATH sticker and denylist', () => {
    expect(classifyPlanReviewRisk('Plan:\n1. docs only')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: single markdown file\nFiles: docs/note.md')).toBe('low')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: .pi/extensions/plan-mode/index.ts')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: .pi/skills/plan-bead/SKILL.md')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: .pi/agents/plan-edge-reviewer.md')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: .pi/rules/domain.md')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: scripts/ping.sh')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: app/pages/index.vue and src-tauri/src/lib.rs')).toBe('high')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: app/utils/helpers.ts')).toBe('low')
    expect(classifyPlanReviewRisk('FAST_PATH_RATIONALE: sticker\nFiles: src-tauri/src/lib.rs')).toBe('low')
  })

  it('gate.ok still ignores NEEDS_CHANGES while important findings are visible for stop advice', () => {
    const results: PlanReviewResult[] = [
      {
        reviewer: 'plan-edge-reviewer',
        verdict: 'NEEDS_CHANGES',
        findings: [{ severity: 'important', issue: 'missing rollback', evidence: 'plan', suggestedFix: 'add rollback' }],
        unresolvedBlockers: [],
        raw: '',
      },
      { reviewer: 'plan-consistency-reviewer', verdict: 'APPROVED', findings: [], unresolvedBlockers: [], raw: '' },
      { reviewer: 'plan-dead-zone-reviewer', verdict: 'APPROVED', findings: [], unresolvedBlockers: [], raw: '' },
    ]
    const gate = evaluatePlanReviewGate(results)
    expect(gate.ok).toBe(true)
    expect(gate.importantFindings).toHaveLength(1)
    expect(hasImportantOrCriticalFindings(results, gate.importantFindings)).toBe(true)
    expect(planReviewStopAdvice({ cycle: 1, gateOk: gate.ok, hasImportantOrCritical: true })).toBe('CONTINUE')
    expect(planReviewStopAdvice({ cycle: 2, gateOk: gate.ok, hasImportantOrCritical: true })).toBe('STOP_SHOW_USER')
  })

  it('runs required reviewers through pi json mode and parses assistant output', async () => {
    const calls: Array<{ command: string, args: string[] }> = []
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args })
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'PLAN REVIEW: APPROVED\nFindings:\n- severity: minor\n  issue: none\n  evidence: reviewed plan\n  suggested fix: none\nUnresolved blockers: none' }],
            },
          }) + '\n',
        }
      },
    }

    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', ['plan-edge-reviewer'])

    expect(calls[0]).toMatchObject({ command: 'pi' })
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      '--mode', 'json',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--tools', 'read,grep,find,ls',
      '--append-system-prompt', '/repo/.pi/agents/plan-edge-reviewer.md',
    ]))
    expect(calls[0]?.args).not.toEqual(expect.arrayContaining(['edit', 'bash']))
    expect(results[0]).toMatchObject({ reviewer: 'plan-edge-reviewer', verdict: 'APPROVED' })
  })

  it('publishes running then terminal cards for the plan-review trio and auto-shows the widget store', async () => {
    const midFlight: string[] = []
    const pi = {
      exec: async (_command: string, args: string[]) => {
        const promptIdx = args.indexOf('--append-system-prompt')
        const agentPath = promptIdx >= 0 ? String(args[promptIdx + 1] ?? '') : ''
        const reviewer = agentPath.split('/').pop()?.replace(/\.md$/, '') ?? 'unknown'
        midFlight.push(`${reviewer}:${getSharedDashboardState()?.cards.get(reviewer)?.status ?? 'missing'}`)
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'PLAN REVIEW: APPROVED\nFindings:\n- severity: minor\n  issue: none\n  evidence: ok\n  suggested fix: none\nUnresolved blockers: none' }],
            },
          }) + '\n',
        }
      },
    }

    expect(getSharedDashboardState()).toBeNull()
    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test')

    expect(results).toHaveLength(3)
    expect(results.every((result) => result.verdict === 'APPROVED')).toBe(true)
    expect(midFlight).toEqual(expect.arrayContaining([
      'plan-edge-reviewer:running',
      'plan-consistency-reviewer:running',
      'plan-dead-zone-reviewer:running',
    ]))

    const shared = getSharedDashboardState()
    expect(shared?.visible).toBe(true)
    expect(shared?.origin).toBe('auto')
    expect(shared?.mode).toBe('active')
    expect(shared?.cards.get('plan-edge-reviewer')?.status).toBe('completed')
    expect(shared?.cards.get('plan-consistency-reviewer')?.status).toBe('completed')
    expect(shared?.cards.get('plan-dead-zone-reviewer')?.status).toBe('completed')
  })

  it('marks the dashboard card failed when pi.exec throws instead of completed', async () => {
    const pi = {
      exec: async () => {
        throw new Error('spawn failed')
      },
    }

    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', ['plan-edge-reviewer'])

    expect(results[0]).toMatchObject({ reviewer: 'plan-edge-reviewer', verdict: 'BLOCKED', error: 'spawn failed' })
    expect(getSharedDashboardState()?.cards.get('plan-edge-reviewer')?.status).toBe('failed')
    expect(getSharedDashboardState()?.cards.get('plan-edge-reviewer')?.errorMessage).toBe('spawn failed')
  })

  it('hasUI uses visible panes, parses printed reports, and does not publish dashboard cards', async () => {
    const spawned: string[] = []
    const tools: Array<string | undefined> = []
    const pi = { exec: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', ['plan-edge-reviewer', 'plan-consistency-reviewer'], {
      hasUI: true,
      spawnVisible: async (input) => {
        spawned.push(...input.agents.map((agent) => agent.role))
        tools.push(...input.agents.map((agent) => agent.tools))
        return input.agents.map((agent) => ({
          role: agent.role,
          taskId: `sync-${agent.role}`,
          pane: `surface:${agent.role}`,
          output: 'PLAN REVIEW: APPROVED\nFindings:\n- severity: minor\n  issue: none\n  evidence: ok\n  suggested fix: none\nUnresolved blockers: none',
        }))
      },
    })

    expect(spawned).toEqual(['plan-edge-reviewer', 'plan-consistency-reviewer'])
    expect(tools.every((value) => value === 'read,grep,find,ls')).toBe(true)
    expect(tools.every((value) => value?.includes('write'))).toBe(false)
    expect(results.every((result) => result.verdict === 'APPROVED')).toBe(true)
    expect(getSharedDashboardState()).toBeNull()
  })

  it('no-UI keeps headless pi json and dashboard cards', async () => {
    const calls: Array<{ command: string, args: string[] }> = []
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args })
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'PLAN REVIEW: APPROVED\nFindings:\n- severity: minor\n  issue: none\n  evidence: ok\n  suggested fix: none\nUnresolved blockers: none' }],
            },
          }) + '\n',
        }
      },
    }
    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', ['plan-edge-reviewer'], { hasUI: false })
    expect(calls[0]?.command).toBe('pi')
    expect(results[0]?.verdict).toBe('APPROVED')
    expect(getSharedDashboardState()?.origin).toBe('auto')
  })

  it('visible spawn passes resolved cheap model/thinking from agent-models for each reviewer', async () => {
    const cwd = makeAgentModelsCwd(cheapPlanReviewConfig)
    const spawned: SpawnSyncVisibleAgentsInput['agents'] = []
    const pi = { exec: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const results = await runPlanReviewers(pi, cwd, 'Plan:\n1. Test', [
      'plan-edge-reviewer',
      'plan-consistency-reviewer',
      'plan-dead-zone-reviewer',
    ], {
      hasUI: true,
      spawnVisible: async (input) => {
        spawned.push(...input.agents)
        return input.agents.map((agent) => ({
          role: agent.role,
          taskId: `sync-${agent.role}`,
          pane: `surface:${agent.role}`,
          output: approvedReviewText,
        }))
      },
    })

    expect(spawned).toHaveLength(3)
    for (const agent of spawned) {
      expect(agent).toMatchObject({ model: 'xai/grok-4.3', thinking: 'medium' })
    }
    expect(results.every((result) => result.verdict === 'APPROVED')).toBe(true)
  })

  it('headless argv includes --model and --thinking from agent-models', async () => {
    const cwd = makeAgentModelsCwd(cheapPlanReviewConfig)
    const calls: Array<{ command: string, args: string[] }> = []
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args })
        return jsonAssistant(approvedReviewText)
      },
    }

    const results = await runPlanReviewers(pi, cwd, 'Plan:\n1. Test', [
      'plan-edge-reviewer',
      'plan-consistency-reviewer',
      'plan-dead-zone-reviewer',
    ], { hasUI: false })

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.command).toBe('pi')
      expect(call.args).toEqual(expect.arrayContaining(['--model', 'xai/grok-4.3', '--thinking', 'medium']))
    }
    expect(results.every((result) => result.verdict === 'APPROVED')).toBe(true)
  })

  it('inherit: reviewer without agent-models entry omits model/thinking flags', async () => {
    const cwd = makeAgentModelsCwd(cheapPlanReviewConfig)
    const spawned: SpawnSyncVisibleAgentsInput['agents'] = []
    const calls: Array<{ command: string, args: string[] }> = []
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args })
        return jsonAssistant(approvedReviewText)
      },
    }

    const visible = await runPlanReviewers(pi, cwd, 'Plan:\n1. Test', ['unknown-reviewer'], {
      hasUI: true,
      spawnVisible: async (input) => {
        spawned.push(...input.agents)
        return input.agents.map((agent) => ({
          role: agent.role,
          taskId: `sync-${agent.role}`,
          pane: `surface:${agent.role}`,
          output: approvedReviewText,
        }))
      },
    })
    expect(visible[0]?.verdict).toBe('APPROVED')
    expect(spawned[0]?.model).toBeUndefined()
    expect(spawned[0]?.thinking).toBeUndefined()

    const headless = await runPlanReviewers(pi, cwd, 'Plan:\n1. Test', ['unknown-reviewer'], { hasUI: false })
    expect(headless[0]?.verdict).toBe('APPROVED')
    expect(calls.at(-1)?.args).not.toEqual(expect.arrayContaining(['--model']))
    expect(calls.at(-1)?.args).not.toEqual(expect.arrayContaining(['--thinking']))
  })

  it('announceVisiblePlanReviewWait writes notify and chat entry with waiting-trio phrases', () => {
    const notifies: Array<{ text: string; level?: string }> = []
    const entries: Array<{ customType: string; data: unknown }> = []
    announceVisiblePlanReviewWait({
      notify: (text, level) => notifies.push({ text, level }),
      appendEntry: (customType, data) => entries.push({ customType, data }),
    })
    expect(PLAN_REVIEW_WAITING_TRIO_NOTICE).toContain('всех троих')
    expect(PLAN_REVIEW_WAITING_TRIO_NOTICE).toContain('после одного')
    expect(notifies).toEqual([{ text: PLAN_REVIEW_WAITING_TRIO_NOTICE, level: 'info' }])
    expect(entries).toEqual([{ customType: PLAN_REVIEW_WAITING_TRIO_ENTRY, data: { content: PLAN_REVIEW_WAITING_TRIO_NOTICE } }])
  })

  it('announceVisiblePlanReviewWait swallows notify and appendEntry failures', () => {
    expect(() => announceVisiblePlanReviewWait({
      notify: () => { throw new Error('notify exploded') },
      appendEntry: () => { throw new Error('append exploded') },
    })).not.toThrow()
  })

  it('hasUI spawn announces waiting-trio before spawnVisible and still waits for results', async () => {
    const order: string[] = []
    const notifies: string[] = []
    const entries: Array<{ customType: string; data: unknown }> = []
    const pi = { exec: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', ['plan-edge-reviewer', 'plan-consistency-reviewer', 'plan-dead-zone-reviewer'], {
      hasUI: true,
      notify: (text) => {
        order.push('notify')
        notifies.push(text)
      },
      appendEntry: (customType, data) => {
        order.push('append')
        entries.push({ customType, data })
      },
      spawnVisible: async (input) => {
        order.push('spawn')
        expect(input.agents).toHaveLength(3)
        return input.agents.map((agent) => ({
          role: agent.role,
          taskId: `sync-${agent.role}`,
          pane: `surface:${agent.role}`,
          output: approvedReviewText,
        }))
      },
    })
    expect(order.slice(0, 3)).toEqual(['notify', 'append', 'spawn'])
    expect(notifies[0]).toContain('всех троих')
    expect(notifies[0]).toContain('после одного')
    expect(entries[0]?.customType).toBe(PLAN_REVIEW_WAITING_TRIO_ENTRY)
    expect(results).toHaveLength(3)
    expect(results.every((result) => result.verdict === 'APPROVED')).toBe(true)
  })

  it('headless runPlanReviewers does not announce waiting-trio', async () => {
    const notifies: string[] = []
    const pi = {
      exec: async () => jsonAssistant(approvedReviewText),
    }
    await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', ['plan-edge-reviewer'], {
      hasUI: false,
      notify: (text) => notifies.push(text),
    })
    expect(notifies).toEqual([])
  })

  it('visible partial timeout keeps extracted APPROVED and blocks only the missing reviewer', async () => {
    const pi = { exec: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', [
      'plan-edge-reviewer',
      'plan-consistency-reviewer',
      'plan-dead-zone-reviewer',
    ], {
      hasUI: true,
      spawnVisible: async (input) => input.agents.map((agent, index) => ({
        role: agent.role,
        taskId: `sync-${agent.role}`,
        pane: `surface:${agent.role}`,
        output: index < 2 ? approvedReviewText : '',
        error: index < 2 ? undefined : 'sync visible agents timed out after 10ms: missing report',
      })),
    })
    expect(results.map((result) => result.verdict)).toEqual(['APPROVED', 'APPROVED', 'BLOCKED'])
    expect(results[0]?.error).toBeUndefined()
    expect(results[1]?.error).toBeUndefined()
    expect(results[2]?.error).toMatch(/timed out after/)
    expect(results[2]?.unresolvedBlockers.join(' ')).toMatch(/missing report/)
    expect(results.filter((result) => result.error?.includes('timed out after'))).toHaveLength(1)
  })

  it('visible spawn throw still maps every reviewer to BLOCKED', async () => {
    const pi = { exec: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const results = await runPlanReviewers(pi, '/repo', 'Plan:\n1. Test', [
      'plan-edge-reviewer',
      'plan-consistency-reviewer',
      'plan-dead-zone-reviewer',
    ], {
      hasUI: true,
      spawnVisible: async () => {
        throw new Error('aborted')
      },
    })
    expect(results).toHaveLength(3)
    expect(results.every((result) => result.verdict === 'BLOCKED')).toBe(true)
    expect(results.every((result) => result.error === 'aborted')).toBe(true)
  })

  it('does not loosen You do not edit files on plan reviewers', () => {
    for (const name of ['plan-edge-reviewer', 'plan-consistency-reviewer', 'plan-dead-zone-reviewer']) {
      const body = fs.readFileSync(path.join(process.cwd(), '.pi', 'agents', `${name}.md`), 'utf8')
      expect(body).toContain('You do not edit files')
    }
  })
})

const fixtureHarmlessTail = `PLAN REVIEW: APPROVED
Findings:
- severity: minor
  issue: none
  evidence: reviewed plan
  suggested fix: none
Unresolved blockers: none

Additionally I spent time thinking about naming conventions and whitespace in comments.`

const fixtureProseBlocker = `PLAN REVIEW: APPROVED
Findings:
- severity: minor
  issue: none
  evidence: reviewed plan
  suggested fix: none
Unresolved blockers: none

This plan cannot proceed: нельзя исполнять until Maxim confirms the rollback path.`

const fixtureMultilineEvidence = `PLAN REVIEW: NEEDS_CHANGES
Findings:
- severity: important
  issue: Missing delivery path
  evidence: The plan says:
  write to journal only
  and never persist the report file
  suggested fix: write the full report to the result file
Unresolved blockers: none`

const fixtureHeaderVsBody = `PLAN REVIEW: APPROVED
Findings:
- severity: minor
  issue: none
  evidence: reviewed plan
  suggested fix: none
Unresolved blockers: none

The implementation must not execute until the worktree lock is recorded.`

describe('plan-review cutter', () => {
  it('keeps multiline evidence instead of cutting at the first newline', () => {
    const result = parsePlanReviewOutput('plan-edge-reviewer', fixtureMultilineEvidence)
    expect(result.findings[0]?.evidence).toContain('The plan says:')
    expect(result.findings[0]?.evidence).toContain('write to journal only')
    expect(result.findings[0]?.evidence).toContain('and never persist the report file')
    expect(result.verdict).toBe('NEEDS_CHANGES')
  })

  it('turns a prose нельзя исполнять paragraph into a blocker when Unresolved blockers is none', () => {
    const result = parsePlanReviewOutput('plan-consistency-reviewer', fixtureProseBlocker)
    expect(result.unresolvedBlockers.join('\n')).toMatch(/нельзя исполнять/)
    expect(evaluatePlanReviewGate([
      result,
      { reviewer: 'plan-edge-reviewer', verdict: 'APPROVED', findings: [{ severity: 'minor', issue: 'none', evidence: 'ok', suggestedFix: 'none' }], unresolvedBlockers: [] },
      { reviewer: 'plan-dead-zone-reviewer', verdict: 'APPROVED', findings: [{ severity: 'minor', issue: 'none', evidence: 'ok', suggestedFix: 'none' }], unresolvedBlockers: [] },
    ]).ok).toBe(false)
  })

  it('does not give a green gate when the header is APPROVED and the body says must not execute', () => {
    const result = parsePlanReviewOutput('plan-dead-zone-reviewer', fixtureHeaderVsBody)
    const gate = evaluatePlanReviewGate([
      { reviewer: 'plan-edge-reviewer', verdict: 'APPROVED', findings: [{ severity: 'minor', issue: 'none', evidence: 'ok', suggestedFix: 'none' }], unresolvedBlockers: [] },
      { reviewer: 'plan-consistency-reviewer', verdict: 'APPROVED', findings: [{ severity: 'minor', issue: 'none', evidence: 'ok', suggestedFix: 'none' }], unresolvedBlockers: [] },
      result,
    ])
    expect(result.unresolvedBlockers.join('\n')).toMatch(/must not execute/)
    expect(gate.ok).toBe(false)
    expect(planReviewStopAdvice({ cycle: 1, gateOk: gate.ok, hasImportantOrCritical: false })).toBe('HARD_BLOCK')
  })

  it('does not copy a harmless extra paragraph into the orchestrator summary', () => {
    const result = parsePlanReviewOutput('plan-edge-reviewer', fixtureHarmlessTail)
    const rendered = renderPlanReviewResults([result])
    expect(rendered).not.toContain('naming conventions')
    expect(rendered).not.toContain('Report file:')
    expect(result.unresolvedBlockers).toEqual([])
    expect(result.verdict).toBe('APPROVED')
    expect(result.raw).toContain('naming conventions')
  })

  it('blocks empty files, missing PLAN REVIEW, and reports with no parsed findings', () => {
    expect(parsePlanReviewOutput('plan-edge-reviewer', '').verdict).toBe('BLOCKED')
    expect(parsePlanReviewOutput('plan-edge-reviewer', 'just prose without a verdict').verdict).toBe('BLOCKED')
    expect(parsePlanReviewOutput('plan-edge-reviewer', 'PLAN REVIEW: APPROVED\nUnresolved blockers: none').verdict).toBe('BLOCKED')
  })

  it('keeps the full printed report beside a summary that omits a harmless tail', () => {
    const tail = 'SECRET FILE TAIL that must not reach the orchestrator context'
    const result = parsePlanReviewOutput('plan-edge-reviewer', `${fixtureMultilineEvidence}\n\n${tail}\n`)
    const rendered = renderPlanReviewResults([result])
    expect(result.findings[0]?.evidence).toContain('never persist the report file')
    expect(rendered).not.toContain('Report file:')
    expect(rendered).not.toContain('SECRET FILE TAIL')
    expect(result.raw).toContain('SECRET FILE TAIL')
  })
})
