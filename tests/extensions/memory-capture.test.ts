import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import memoryCaptureExtension, { parseMemoryCapture } from '../../.pi/extensions/memory-capture/index'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-capture-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function registerHandler() {
  let handler: ((event: any, ctx: any) => Promise<unknown>) | undefined
  memoryCaptureExtension({
    on: vi.fn((event, callback) => {
      if (event === 'tool_call') handler = callback as typeof handler
    }),
  } as any)
  if (!handler) throw new Error('tool_call handler was not registered')
  return handler
}

function readKnowledge(dir: string) {
  const file = path.join(dir, '.beads', 'memory', 'knowledge.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

describe('memory-capture parsing', () => {
  it('bounds a chained bd comment to the actual comment argument', () => {
    const capture = parseMemoryCapture('bd comments add BID "LEARNED: useful fact" --json && echo bad')

    expect(capture).toEqual({ bead: 'BID', type: 'learned', content: 'useful fact' })
  })

  it('parses a simple bd comment before flags', () => {
    const capture = parseMemoryCapture('bd comments add BID "LEARNED: useful fact" --json')

    expect(capture).toEqual({ bead: 'BID', type: 'learned', content: 'useful fact' })
  })

  it('ignores comments without supported markers', () => {
    expect(parseMemoryCapture('bd comments add BID "regular comment" --json')).toBeUndefined()
  })
})

describe('memory-capture approval flow', () => {
  it('persists approved proposals and explains what will be recorded', async () => {
    const cwd = makeTempDir()
    const confirm = vi.fn().mockResolvedValue(true)
    const notify = vi.fn()
    const handler = registerHandler()

    await handler(
      { toolName: 'bash', input: { command: 'bd comments add BID "LEARNED: useful fact" --json && echo ignored' } },
      { cwd, hasUI: true, ui: { confirm, notify } },
    )

    const entries = readKnowledge(cwd)
    expect(confirm).toHaveBeenCalledWith(
      'Approve memory capture?',
      expect.stringContaining('Content:\nuseful fact'),
    )
    const promptMessage = confirm.mock.calls[0]?.[1]
    expect(promptMessage).toContain('durable project memory')
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toBeDefined()
    expect(entry!.content).toBe('useful fact')
    expect(entry!.content).not.toContain('--json')
    expect(entry!.content).not.toContain('&&')
  })

  it('does not persist rejected proposals', async () => {
    const cwd = makeTempDir()
    const handler = registerHandler()

    await handler(
      { toolName: 'bash', input: { command: 'bd comments add BID "LEARNED: useful fact" --json' } },
      { cwd, hasUI: true, ui: { confirm: vi.fn().mockResolvedValue(false), notify: vi.fn() } },
    )

    expect(readKnowledge(cwd)).toEqual([])
  })

  it('does not prompt or persist for non-marker comments', async () => {
    const cwd = makeTempDir()
    const confirm = vi.fn()
    const handler = registerHandler()

    await handler(
      { toolName: 'bash', input: { command: 'bd comments add BID "regular comment" --json' } },
      { cwd, hasUI: true, ui: { confirm, notify: vi.fn() } },
    )

    expect(confirm).not.toHaveBeenCalled()
    expect(readKnowledge(cwd)).toEqual([])
  })
})
