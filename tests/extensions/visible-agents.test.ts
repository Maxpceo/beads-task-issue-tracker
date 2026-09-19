import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  findRegistryByTaskId,
  loadRegistry,
  setCmuxAdapterForTests,
  type CmuxAdapter,
} from '../../.pi/extensions/beads-dispatch/index'
import {
  spawnSyncVisibleAgents,
} from '../../.pi/extensions/beads-dispatch/visible-agents'

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
        const taskMatch = text.match(/Task: read ([^'\s]+) and execute/)
        const taskFile = taskMatch?.[1]
        if (!taskFile || !fs.existsSync(taskFile)) return
        const body = fs.readFileSync(taskFile, 'utf8')
        const resultMatch = body.match(/write your final report to ([^\n]+)/)
        if (resultMatch?.[1]) fs.writeFileSync(resultMatch[1], 'PLAN REVIEW: APPROVED\nUnresolved blockers: none\n')
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

  it('fail-fast on dead pane without result', async () => {
    const closed: string[] = []
    const results = await spawnSyncVisibleAgents({
      adapter: adapter({
        async closeSurface(surface) { closed.push(surface) },
        async readScreen() { return 'user@host ~/proj $\n' },
      }),
      worktreePath: tmp,
      branch: 'feat/x',
      pollMs: 1,
      timeoutMs: 2000,
      sleep: async () => {},
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
          const taskMatch = text.match(/Task: read ([^'\s]+) and execute/)
          const taskPath = taskMatch?.[1]
          if (!taskPath || !fs.existsSync(taskPath)) return
          const body = fs.readFileSync(taskPath, 'utf8')
          const resultMatch = body.match(/write your final report to ([^\n]+)/)
          if (resultMatch?.[1]) resultFile = resultMatch[1]
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
          const taskMatch = text.match(/Task: read ([^'\s]+) and execute/)
          const taskPath = taskMatch?.[1]
          if (!taskPath || !fs.existsSync(taskPath)) return
          const body = fs.readFileSync(taskPath, 'utf8')
          const resultMatch = body.match(/write your final report to ([^\n]+)/)
          if (resultMatch?.[1]) resultFile = resultMatch[1]
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

  it('timeout closes spawned panes', async () => {
    const closed: string[] = []
    let now = 0
    await expect(spawnSyncVisibleAgents({
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
    })).rejects.toThrow(/timed out/)
    expect(closed).toEqual(['surface:a1'])
  })
})
