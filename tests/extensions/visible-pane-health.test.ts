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
} from '../../.pi/extensions-aside-v1dt/beads-dispatch/cmux-transport'

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

/** Live frames from bpaz watchdog jsonl (false dead after grace); padding stripped for git diff --check. */
const bpazStartupChrome = 'pi v0.85.1\nescape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more'
const bpazLiveAssistant = 'Сверю черновик с формулировкой bpaz и критериями приёмки, не меняя рабочие файлы.'
const bpazLiveFindings = '    evidence: "1. Confirm this is an observe-only plan-review spawn. 2. Return PLAN REVIEW:\n  APPROVED." / "FAST_PATH_RATIONALE: one live trio to capture watchdog jsonl; no classify'

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

  it('does not treat thinking inside a filename as busy', () => {
    const recap = `Files: tests/extensions/subagent-thinking-argv.test.ts\n$\nsession idle | bead=0qsm`
    expect(classifyVisiblePane(recap)).toBe('waiting')
    expect(classifyVisiblePane('path/to/busy-work.md\nsession implementing')).toBe('waiting')
  })

  it('treats a shell prompt without a Pi session-line as shell', () => {
    expect(classifyVisiblePane(shellOnly)).toBe('shell')
    expect(classifyVisiblePane('user@host ~/proj $\n')).toBe('shell')
    expect(classifyVisiblePane('❯ ')).toBe('shell')
  })

  it('treats empty screen as dead and non-shell live text as starting', () => {
    expect(classifyVisiblePane('')).toBe('dead')
    expect(classifyVisiblePane(deadScreen)).toBe('starting')
  })

  it('classifies bpaz watchdog frames as starting, not dead', () => {
    expect(classifyVisiblePane(bpazStartupChrome)).toBe('starting')
    expect(classifyVisiblePane(bpazLiveAssistant)).toBe('starting')
    expect(classifyVisiblePane(bpazLiveFindings)).toBe('starting')
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
