import { describe, expect, it, vi } from 'vitest'

import followUpReminderExtension, {
  extractFollowUpCandidates,
  formatFollowUps,
  reduceFollowUpState,
  type FollowUpCandidate,
} from '../../.pi/extensions/follow-up-reminder/index'

function candidate(overrides: Partial<FollowUpCandidate> = {}): FollowUpCandidate {
  return {
    id: 'fu-1',
    markerType: 'follow-up bead',
    snippet: 'follow-up bead for a concrete issue',
    activeBead: 'beads-task-issue-tracker-tbc6',
    branch: 'task/tbc6-follow-up-reminder',
    worktreePath: '/tmp/tbc6',
    sourceEntryId: 'entry-1',
    sourceTime: '2026-05-11T00:00:00.000Z',
    status: 'open',
    ...overrides,
  }
}

function custom(data: unknown) {
  return { type: 'custom', customType: 'follow-up-reminder', data }
}

function workflow(data: unknown) {
  return { type: 'custom', customType: 'workflow-state', data }
}

function createHarness(entries: unknown[] = []) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>()
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<unknown> | unknown }>()
  const appended: Array<[string, unknown]> = []
  const notify = vi.fn()
  const sendMessage = vi.fn()
  const pi = {
    appendEntry: vi.fn((type: string, data: unknown) => appended.push([type, data])),
    on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler)),
    registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: any) => unknown }) => commands.set(name, config)),
    sendMessage,
  }
  followUpReminderExtension(pi as any)

  function ctx(extraEntries: unknown[] = []) {
    return {
      hasUI: true,
      sessionManager: {
        getEntries: () => [...entries, ...extraEntries, ...appended.map(([type, data]) => ({ type: 'custom', customType: type, data }))],
        getLeafId: () => 'leaf-1',
      },
      ui: { notify },
    }
  }

  return { handlers, commands, appended, notify, sendMessage, ctx }
}

describe('follow-up-reminder marker extraction', () => {
  it('extracts conservative English and Russian markers with scope metadata', () => {
    const result = extractFollowUpCandidates(
      'This is outside scope. Заметил: это можно отложить и оформить отдельным bead.',
      { activeBead: 'beads-task-issue-tracker-tbc6', branch: 'task/tbc6-follow-up-reminder' },
      { entryId: 'entry-1', time: '2026-05-11T00:00:00.000Z' },
    )

    expect(result.map((item) => item.markerType)).toEqual(['outside scope', 'отдельный bead', 'можно отложить'])
    expect(result[0]?.activeBead).toBe('beads-task-issue-tracker-tbc6')
    expect(result[0]?.sourceEntryId).toBe('entry-1')
  })

  it('ignores low-confidence generic wording without concrete marker', () => {
    expect(extractFollowUpCandidates('Maybe later this could be nice to have.')).toEqual([])
  })

  it('deduplicates repeated marker snippets in one extraction pass', () => {
    const result = extractFollowUpCandidates('follow-up bead: add docs. follow-up bead: add docs.')

    expect(result).toHaveLength(1)
  })
})

describe('follow-up-reminder state reduction', () => {
  it('applies candidate, resolve, clear, and scope-aware clear-all events', () => {
    const first = candidate({ id: 'fu-1', branch: 'task/a' })
    const second = candidate({ id: 'fu-2', branch: 'task/b' })

    const result = reduceFollowUpState([
      custom({ version: 1, action: 'candidate', candidate: first }),
      custom({ version: 1, action: 'candidate', candidate: second }),
      custom({ version: 1, action: 'resolve', id: 'fu-1', reason: 'manual', at: '2026-05-11T00:00:00.000Z' }),
      custom({ version: 1, action: 'clear-all', reason: 'branch clear', at: '2026-05-11T00:00:00.000Z', scope: { branch: 'task/b' } }),
    ] as any)

    expect(result.find((item) => item.id === 'fu-1')?.status).toBe('resolved')
    expect(result.find((item) => item.id === 'fu-2')?.status).toBe('cleared')
  })

  it('ignores corrupted, malformed, or unknown custom entries without throwing', () => {
    const result = reduceFollowUpState([
      custom({ version: 2, action: 'candidate', candidate: candidate() }),
      custom({ version: 1, action: 'candidate' }),
      custom({ version: 1, action: 'candidate', candidate: null }),
      custom({ version: 1, action: 'candidate', candidate: { id: 'fu-bad' } }),
      custom({ version: 1, action: 'resolve' }),
      custom({ version: 1, action: 'clear', id: 42, reason: 'bad', at: '2026-05-11T00:00:00.000Z' }),
      custom({ version: 1, action: 'clear-all', reason: 'bad', at: '2026-05-11T00:00:00.000Z', scope: null }),
      custom({ bad: true }),
      { type: 'custom', customType: 'other', data: { version: 1 } },
    ] as any)

    expect(result).toEqual([])
  })
})

describe('follow-up-reminder extension commands and events', () => {
  it('persists candidates from assistant messages and avoids duplicates across session entries', async () => {
    const h = createHarness([
      workflow({ activeBead: 'beads-task-issue-tracker-tbc6', branch: 'task/tbc6-follow-up-reminder' }),
    ])
    const event = { message: { role: 'assistant', content: [{ type: 'text', text: 'Follow-up bead: add docs.' }] } }

    await h.handlers.get('message_end')?.(event, h.ctx())
    await h.handlers.get('message_end')?.(event, h.ctx())

    expect(h.appended.filter(([type]) => type === 'follow-up-reminder')).toHaveLength(1)
  })

  it('lists unresolved candidates and handles empty state', async () => {
    const h = createHarness([custom({ version: 1, action: 'candidate', candidate: candidate() })])

    await h.commands.get('followups')?.handler('', h.ctx())

    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Unresolved follow-up candidates (1)'), 'info')
    expect(formatFollowUps([])).toBe('No unresolved follow-up candidates.')
  })

  it('resolves and clears candidates manually without creating bd issues', async () => {
    const h = createHarness([custom({ version: 1, action: 'candidate', candidate: candidate() })])

    await h.commands.get('followups')?.handler('resolve fu-1', h.ctx())
    await h.commands.get('followups')?.handler('clear fu-1', h.ctx())

    expect(h.appended.map(([, data]) => (data as { action: string }).action)).toEqual(['resolve', 'clear'])
  })

  it('does not mutate state for unknown manual resolve ids', async () => {
    const h = createHarness([custom({ version: 1, action: 'candidate', candidate: candidate() })])

    await h.commands.get('followups')?.handler('resolve fu-missing', h.ctx())

    expect(h.appended).toEqual([])
    expect(h.notify).toHaveBeenCalledWith('Unknown follow-up candidate: fu-missing', 'error')
  })

  it('shows advisory landing reminder but continues input processing', async () => {
    const h = createHarness([custom({ version: 1, action: 'candidate', candidate: candidate() })])

    const result = await h.handlers.get('input')?.({ text: '/land', source: 'interactive' }, h.ctx())

    expect(result).toEqual({ action: 'continue' })
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Follow-up reminder before landing'), 'warning')
  })

  it('auto-resolves only on successful reliable discovered-from or explicit resolved marker evidence', async () => {
    const h = createHarness([
      workflow({ activeBead: 'beads-task-issue-tracker-tbc6', branch: 'task/tbc6-follow-up-reminder' }),
      custom({ version: 1, action: 'candidate', candidate: candidate() }),
    ])

    await h.handlers.get('tool_result')?.({ toolName: 'bash', isError: true, input: { command: 'bd create X --deps discovered-from:beads-task-issue-tracker-tbc6' } }, h.ctx())
    await h.handlers.get('tool_result')?.({ toolName: 'bash', isError: false, input: { command: 'bd create X --deps discovered-from:beads-task-issue-tracker-tbc6' } }, h.ctx())
    await h.handlers.get('tool_result')?.({ toolName: 'bash', isError: false, input: { command: 'bd comments add X FOLLOWUP_RESOLVED:fu-1' } }, h.ctx())

    expect(h.appended.map(([, data]) => (data as { action: string }).action)).toEqual(['resolve', 'resolve'])
  })

  it('emits a non-blocking shutdown reminder for unresolved candidates', async () => {
    const h = createHarness([custom({ version: 1, action: 'candidate', candidate: candidate() })])

    await h.handlers.get('session_shutdown')?.({}, h.ctx())

    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Follow-up reminder: 1 unresolved'), 'warning')
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'follow-up-reminder', display: true }), { triggerTurn: false })
  })
})
