import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  type CmuxAdapter,
  findRegistryByTaskId,
  loadRegistry,
  setCmuxAdapterForTests,
} from '../../.pi/extensions/beads-dispatch/cmux-transport'
import {
  BPAZ_WATCHDOG_TRACE_RELATIVE_PATH,
  extractPlanReviewFromJournal,
  spawnSyncVisibleAgents,
} from '../../.pi/extensions/beads-dispatch/visible-agents'

const approvedReport = `PLAN REVIEW: APPROVED
Findings:
- severity: minor
  issue: none
  evidence: fixture journal
  suggested fix: none
Unresolved blockers: none`

function taskFileFromPayload(text: string): string | undefined {
  return text.match(/Task: read ([^'\s]+) and execute/)?.[1]
}

function resultFileFromTaskFile(taskFile: string): string {
  return taskFile.replace(`${path.sep}tasks${path.sep}`, `${path.sep}results${path.sep}`)
}

function sessionDirFromPayload(text: string): string | undefined {
  return text.match(/'--session'\s+'([^']+)'/)?.[1]
}

function writePlanReviewJournal(sessionDir: string, report: string, thinking = 'secret draft thinking must not leak'): string {
  fs.mkdirSync(sessionDir, { recursive: true })
  const journal = [
    { type: 'session', version: 3, id: 'fixture' },
    {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Return PLAN REVIEW: APPROVED | NEEDS_CHANGES | BLOCKED. Template PLAN REVIEW: A | B | C is not a verdict.' }],
      },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking },
          { type: 'text', text: report },
        ],
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n'
  fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), journal)
  return journal
}

describe('spawnSyncVisibleAgents', () => {
  let tmp: string
  const prevOrch = process.env.ORCH_ROOT
  const prevHome = process.env.HOME

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '0qsm-sync-'))
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

  function adapter(overrides: Partial<CmuxAdapter> & { splits?: Array<{ anchor?: string; direction?: string }> } = {}): CmuxAdapter {
    let n = 0
    const splits = overrides.splits ?? []
    return {
      callerSurface: () => 'surface:orch',
      async identify() { return { workspaceId: 'ws-sync' } },
      async newSplit(opts) {
        n += 1
        splits.push({ anchor: opts?.anchorSurface, direction: opts?.direction })
        return { surface: `surface:a${n}` }
      },
      async send() {},
      async closeSurface() {},
      async readScreen() { return 'thinking busy' },
      async renameSurface() {},
      ...overrides,
    }
  }

  it('spawns, polls result files, closes panes and tombstones', async () => {
    const splits: Array<{ anchor?: string; direction?: string }> = []
    const closed: string[] = []
    const live = adapter({
      splits,
      async closeSurface(surface) { closed.push(surface) },
      async send(_surface, text) {
        expect(text).toContain('--session')
        expect(text).not.toContain('--no-session')
        const taskFile = taskFileFromPayload(text)
        if (!taskFile || !fs.existsSync(taskFile)) return
        fs.writeFileSync(resultFileFromTaskFile(taskFile), 'PLAN REVIEW: APPROVED\nUnresolved blockers: none\n')
      },
    })
    const results = await spawnSyncVisibleAgents({
      adapter: live,
      worktreePath: tmp,
      branch: 'feat/x',
      beadId: 'beads-task-issue-tracker-0qsm',
      pollMs: 1,
      timeoutMs: 2000,
      sleep: async () => {},
      agents: [
        { role: 'plan-edge-reviewer', task: 'Review plan', systemPrompt: '# edge', tools: 'read,write' },
        { role: 'plan-consistency-reviewer', task: 'Review plan', systemPrompt: '# cons', tools: 'read,write' },
      ],
    })
    expect(results).toHaveLength(2)
    expect(results.every((row) => row.output.includes('APPROVED'))).toBe(true)
    expect(splits[0]).toEqual({ anchor: 'surface:orch', direction: 'right' })
    expect(splits[1]).toEqual({ anchor: 'surface:a1', direction: 'right' })
    expect(closed.sort()).toEqual(['surface:a1', 'surface:a2'].sort())
    expect(findRegistryByTaskId(results[0]!.taskId)?.entry.status).toBe('tombstone')
    expect(findRegistryByTaskId(results[0]!.taskId)?.entry.kind).toBe('sync')
    const registry = loadRegistry(path.join(tmp, 'ns', 'ws-sync', 'dispatch-registry.json'))
    expect(registry.entries.every((entry) => entry.status === 'tombstone')).toBe(true)
  })

  it('keeps a startup shell-prompt pending until the result file exists', async () => {
    let resultFile = ''
    const closed: string[] = []
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async send(_surface, text) {
          const taskPath = taskFileFromPayload(text)
          if (!taskPath || !fs.existsSync(taskPath)) return
          resultFile = resultFileFromTaskFile(taskPath)
        },
        async readScreen() { return 'user@host ~/proj $\n' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      startupGraceMs: 50,
      now: () => 0,
      sleep: async () => {
        if (resultFile) fs.writeFileSync(resultFile, 'started after shell\n')
      },
      agents: [{ role: 'detective', task: 'Investigate', systemPrompt: '# d', tools: 'read' }],
    })
    expect(results[0]?.error).toBeUndefined()
    expect(results[0]?.output).toContain('started after shell')
    expect(closed).toEqual(['surface:a1'])
  })

  it('marks the same shell-prompt dead after startup grace without a result file', async () => {
    const closed: string[] = []
    let now = 0
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async readScreen() { return 'user@host ~/proj $\n' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      startupGraceMs: 30,
      now: () => now,
      sleep: async () => { now += 40 },
      agents: [{ role: 'detective', task: 'Investigate', systemPrompt: '# d', tools: 'read' }],
    })
    expect(results[0]?.error).toMatch(/dead pane without result/)
    expect(closed).toEqual(['surface:a1'])
  })

  it('fail-fast on dead pane without result', async () => {
    const closed: string[] = []
    let now = 0
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async readScreen() { return 'surface closed\nno prompt here' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      startupGraceMs: 30,
      now: () => now,
      sleep: async () => { now += 40 },
      classifyPane: () => 'dead',
      agents: [{ role: 'detective', task: 'Investigate', systemPrompt: '# d', tools: 'read' }],
    })
    expect(results[0]?.error).toMatch(/dead pane without result/)
    expect(closed).toEqual(['surface:a1'])
  })

  it('abort closes spawned panes', async () => {
    const closed: string[] = []
    const controller = new AbortController()
    const pending = spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async readScreen() { return 'thinking busy' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 5,
      timeoutMs: 10_000,
      signal: controller.signal,
      sleep: async (_ms, signal) => {
        controller.abort()
        if (signal?.aborted) throw new Error('aborted')
      },
      agents: [{ role: 'architect', task: 'Design', systemPrompt: '# a', tools: 'read' }],
    })
    await expect(pending).rejects.toThrow(/aborted/)
    expect(closed).toEqual(['surface:a1'])
  })

  it('empty readScreen does not mark dead; waits until result file exists', async () => {
    let resultFile = ''
    const closed: string[] = []
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async send(_surface, text) {
          const taskPath = taskFileFromPayload(text)
          if (!taskPath || !fs.existsSync(taskPath)) return
          resultFile = resultFileFromTaskFile(taskPath)
        },
        async readScreen() { return '' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      sleep: async () => {
        if (resultFile) fs.writeFileSync(resultFile, 'recovered after empty screen\n')
      },
      agents: [{ role: 'detective', task: 'Investigate', systemPrompt: '# d', tools: 'read' }],
    })
    expect(results[0]?.error).toBeUndefined()
    expect(results[0]?.output).toContain('recovered after empty screen')
    expect(closed).toEqual(['surface:a1'])
  })

  it('readScreen throw does not mark dead; waits until result file exists', async () => {
    let resultFile = ''
    const closed: string[] = []
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async send(_surface, text) {
          const taskPath = taskFileFromPayload(text)
          if (!taskPath || !fs.existsSync(taskPath)) return
          resultFile = resultFileFromTaskFile(taskPath)
        },
        async readScreen() { throw new Error('transient read-screen') },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      sleep: async () => {
        if (resultFile) fs.writeFileSync(resultFile, 'recovered after throw\n')
      },
      agents: [{ role: 'detective', task: 'Investigate', systemPrompt: '# d', tools: 'read' }],
    })
    expect(results[0]?.error).toBeUndefined()
    expect(results[0]?.output).toContain('recovered after throw')
    expect(closed).toEqual(['surface:a1'])
  })

  it('does not fail-fast after grace on live non-shell text from watchdog trace', async () => {
    const liveFrame = ' Сверю черновик с формулировкой bpaz и критериями приёмки, не меняя рабочие файлы.\n'
    let resultFile = ''
    let now = 0
    let polls = 0
    const closed: string[] = []
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async send(_surface, text) {
          const taskPath = taskFileFromPayload(text)
          if (!taskPath || !fs.existsSync(taskPath)) return
          resultFile = resultFileFromTaskFile(taskPath)
        },
        async readScreen() { return liveFrame },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      startupGraceMs: 30,
      now: () => now,
      sleep: async () => {
        now += 40
        polls += 1
        if (polls >= 2 && resultFile) fs.writeFileSync(resultFile, 'PLAN REVIEW: APPROVED\n')
      },
      agents: [{ role: 'plan-consistency-reviewer', task: 'Review plan', systemPrompt: '# c', tools: 'read' }],
    })
    expect(results[0]?.error).toBeUndefined()
    expect(results[0]?.output).toContain('APPROVED')
    expect(closed).toEqual(['surface:a1'])
  })

  it('watchdog jsonl does not change xdpq shell-grace fail-fast', async () => {
    const closed: string[] = []
    let now = 0
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async readScreen() { return 'user@host ~/proj $\n' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      startupGraceMs: 30,
      now: () => now,
      sleep: async () => { now += 40 },
      agents: [{ role: 'detective', task: 'Investigate', systemPrompt: '# d', tools: 'read' }],
    })
    expect(results[0]?.error).toMatch(/dead pane without result: surface:a1/)
    expect(closed).toEqual(['surface:a1'])
    const traceFile = path.join(tmp, BPAZ_WATCHDOG_TRACE_RELATIVE_PATH)
    expect(fs.existsSync(traceFile)).toBe(true)
    const samples = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      pane: string
      ageMs: number
      health: string
      hasResultFile: boolean
      excerpt: string
    })
    expect(samples.length).toBeGreaterThanOrEqual(1)
    expect(samples.every((sample) => sample.pane === 'surface:a1')).toBe(true)
    expect(samples.some((sample) => sample.health === 'shell' && sample.hasResultFile === false)).toBe(true)
    expect(samples.some((sample) => sample.excerpt.includes('user@host'))).toBe(true)
    expect(samples.every((sample) => sample.excerpt.length <= 200)).toBe(true)
    expect(samples.some((sample) => sample.ageMs >= 30)).toBe(true)
  })

  it('timeout without a report does not throw and does not close the pane', async () => {
    const closed: string[] = []
    let now = 0
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async readScreen() { return 'thinking busy' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 10,
      now: () => now,
      sleep: async () => { now += 20 },
      agents: [{ role: 'architect', task: 'Design', systemPrompt: '# a', tools: 'read' }],
    })
    expect(results[0]?.error).toMatch(/timed out after/)
    expect(results[0]?.error).toMatch(/missing report/)
    expect(results[0]?.output).toBe('')
    expect(closed).toEqual([])
    expect(findRegistryByTaskId(results[0]!.taskId)?.entry.status).toBe('spawned')
  })

  it('extracts PLAN REVIEW from a journal with thinking and ignores the prompt template', () => {
    const journal = writePlanReviewJournal(path.join(tmp, 'journal-fixture'), approvedReport)
    const extracted = extractPlanReviewFromJournal(journal)
    expect(extracted).toBe(approvedReport)
    expect(extracted).toContain('PLAN REVIEW: APPROVED')
    expect(extracted).toContain('Findings:')
    expect(extracted).not.toContain('secret draft thinking')
    expect(extracted).not.toMatch(/PLAN REVIEW:\s*A\s*\|\s*B\s*\|\s*C/)
    expect(journal).toContain('secret draft thinking must not leak')
    expect(journal.length).toBeGreaterThan((extracted ?? '').length)
  })

  it('does not treat incomplete jsonl or template-only assistant text as delivery', () => {
    const incomplete = '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"PLAN REVIEW: APPROVED'
    expect(extractPlanReviewFromJournal(incomplete)).toBeUndefined()
    const templateOnly = `${JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Use PLAN REVIEW: A | B | C' }] },
    })}\n`
    expect(extractPlanReviewFromJournal(templateOnly)).toBeUndefined()
    expect(extractPlanReviewFromJournal('')).toBeUndefined()
  })

  it('delivers three journal extracts on time and closes those panes', async () => {
    const closed: string[] = []
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async send(_surface, text) {
          const sessionDir = sessionDirFromPayload(text)
          if (sessionDir) writePlanReviewJournal(sessionDir, approvedReport)
        },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      sleep: async () => {},
      agents: [
        { role: 'plan-edge-reviewer', task: 'Review plan', systemPrompt: '# e', tools: 'read,grep,find,ls' },
        { role: 'plan-consistency-reviewer', task: 'Review plan', systemPrompt: '# c', tools: 'read,grep,find,ls' },
        { role: 'plan-dead-zone-reviewer', task: 'Review plan', systemPrompt: '# d', tools: 'read,grep,find,ls' },
      ],
    })
    expect(results).toHaveLength(3)
    expect(results.every((row) => row.output.includes('PLAN REVIEW: APPROVED'))).toBe(true)
    expect(results.every((row) => !row.output.includes('secret draft thinking'))).toBe(true)
    expect(results.every((row) => !row.error)).toBe(true)
    expect(closed.sort()).toEqual(['surface:a1', 'surface:a2', 'surface:a3'].sort())
  })

  it('returns two journal extracts plus one timeout without throwing or closing the missing pane', async () => {
    const closed: string[] = []
    let now = 0
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async send(_surface, text) {
          const sessionDir = sessionDirFromPayload(text)
          if (!sessionDir) return
          if (text.includes('plan-edge-reviewer') || text.includes('plan-consistency-reviewer')) {
            writePlanReviewJournal(sessionDir, approvedReport)
          }
        },
        async readScreen() { return 'thinking busy' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 10,
      now: () => now,
      sleep: async () => { now += 20 },
      agents: [
        { role: 'plan-edge-reviewer', task: 'Review plan', systemPrompt: '# e', tools: 'read' },
        { role: 'plan-consistency-reviewer', task: 'Review plan', systemPrompt: '# c', tools: 'read' },
        { role: 'plan-dead-zone-reviewer', task: 'Review plan', systemPrompt: '# d', tools: 'read' },
      ],
    })
    expect(results).toHaveLength(3)
    expect(results.filter((row) => row.output.includes('PLAN REVIEW: APPROVED'))).toHaveLength(2)
    expect(results.filter((row) => row.error?.includes('timed out after'))).toHaveLength(1)
    expect(results.filter((row) => row.error?.includes('timed out after'))[0]?.role).toBe('plan-dead-zone-reviewer')
    expect(closed.sort()).toEqual(['surface:a1', 'surface:a2'].sort())
    expect(findRegistryByTaskId(results[2]!.taskId)?.entry.status).toBe('spawned')
  })
})
