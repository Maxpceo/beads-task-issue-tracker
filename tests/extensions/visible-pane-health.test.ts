import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildVisibleChildArgv,
  buildVisibleChildSpawnPayload,
  buildVisibleFollowupPayload,
  classifyVisiblePane,
  followupPayloadLooksLikeSpawnArgv,
  loadRegistry,
  saveRegistry,
  type DispatchRegistryEntry,
} from '../../.pi/extensions/beads-dispatch/cmux-transport'

const idleFooter = `Fix the filter
$
session idle | bead=kp4r | branch=feat/x`

const implementingFooter = `running tests
$ pnpm test
session implementing`

const inreviewFooter = `SUPERVISOR ARTIFACT
Status: DONE
$
session inreview`

const thinkingScreen = `thinking about the plan
session implementing`

const busyScreen = `busy
session idle`

const shellOnly = `maksim@studio kp4r-supervisor-panel-reuse %`

const deadScreen = `surface closed
no prompt here`

describe('classifyVisiblePane', () => {
  it('treats session idle/implementing/inreview as waiting even with $ in the body', () => {
    expect(classifyVisiblePane(idleFooter)).toBe('waiting')
    expect(classifyVisiblePane(implementingFooter)).toBe('waiting')
    expect(classifyVisiblePane(inreviewFooter)).toBe('waiting')
  })

  it('treats thinking/busy as busy even with a session-line', () => {
    expect(classifyVisiblePane(thinkingScreen)).toBe('busy')
    expect(classifyVisiblePane(busyScreen)).toBe('busy')
  })

  it('treats a shell prompt without a Pi session-line as shell', () => {
    expect(classifyVisiblePane(shellOnly)).toBe('shell')
    expect(classifyVisiblePane('user@host ~/proj $\n')).toBe('shell')
    expect(classifyVisiblePane('❯ ')).toBe('shell')
  })

  it('treats a successful read without session-line or shell as dead', () => {
    expect(classifyVisiblePane(deadScreen)).toBe('dead')
    expect(classifyVisiblePane('')).toBe('dead')
  })
})

describe('buildVisibleFollowupPayload', () => {
  it('appends a trailing newline and does not wrap spawn argv', () => {
    expect(buildVisibleFollowupPayload('Fix the pane')).toBe('Fix the pane\n')
    expect(buildVisibleFollowupPayload('Fix the pane\n')).toBe('Fix the pane\n')
    const payload = buildVisibleFollowupPayload('Fix the pane')
    expect(followupPayloadLooksLikeSpawnArgv(payload)).toBe(false)
    const spawn = buildVisibleChildSpawnPayload(
      '/tmp/wt',
      buildVisibleChildArgv({ systemPromptFile: 'a.md', taskFile: 't.md', session: { kind: 'no-session' } }),
    )
    expect(followupPayloadLooksLikeSpawnArgv(spawn)).toBe(true)
    expect(payload).not.toBe(spawn)
  })

  it('does not filter cd/pi substrings in user task text', () => {
    const task = 'Document why `cd /tmp && pi` must not be sent into a live TUI'
    expect(buildVisibleFollowupPayload(task)).toBe(`${task}\n`)
  })

  it('blocks a blank task', () => {
    expect(() => buildVisibleFollowupPayload('')).toThrow(/пустой task/)
    expect(() => buildVisibleFollowupPayload('   \n')).toThrow(/пустой task/)
  })
})

describe('DispatchRegistryEntry hung fields', () => {
  it('roundtrips sendFailCount and hung on a spawned entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp4r-health-'))
    try {
      const file = path.join(dir, 'dispatch-registry.json')
      const entry: DispatchRegistryEntry = {
        taskId: 'task-1',
        beadId: 'bead-a',
        pane: 'surface:1',
        worktree: dir,
        role: 'test-supervisor',
        model: '',
        taskFile: 't.md',
        resultFile: 'r.md',
        digestFile: 'd.digest',
        promptFile: 'p.md',
        status: 'spawned',
        sendFailCount: 2,
        hung: true,
        createdAt: 't',
      }
      saveRegistry(file, { entries: [entry] })
      const loaded = loadRegistry(file).entries[0]
      expect(loaded?.sendFailCount).toBe(2)
      expect(loaded?.hung).toBe(true)
      expect(loaded?.status).toBe('spawned')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
