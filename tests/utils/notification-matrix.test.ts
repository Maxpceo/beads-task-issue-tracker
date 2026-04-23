import { describe, it, expect } from 'vitest'
import { computeNotifyEvents } from '../../app/utils/notification-matrix'
import type { Issue } from '../../app/types/issue'

function makeIssue(id: string, status: string, title = `Issue ${id}`): Issue {
  return {
    id,
    title,
    status,
    type: 'task',
    priority: 'p2',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  } as Issue
}

describe('computeNotifyEvents', () => {
  it('detects created: id in new, absent in old', () => {
    const old: Issue[] = []
    const fresh = [makeIssue('abc-001', 'open')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'created', id: 'abc-001' })
  })

  it('detects deleted: id in old, absent in new', () => {
    const old = [makeIssue('abc-001', 'open')]
    const fresh: Issue[] = []
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'deleted', id: 'abc-001' })
  })

  it('detects closed: status → closed', () => {
    const old = [makeIssue('abc-001', 'open')]
    const fresh = [makeIssue('abc-001', 'closed')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'statusTransition', toastKey: 'closed' })
  })

  it('detects reopened: from=closed to=open', () => {
    const old = [makeIssue('abc-001', 'closed')]
    const fresh = [makeIssue('abc-001', 'open')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'statusTransition', toastKey: 'reopened' })
  })

  it('detects reopened: from=closed to=in_progress', () => {
    const old = [makeIssue('abc-001', 'closed')]
    const fresh = [makeIssue('abc-001', 'in_progress')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'statusTransition', toastKey: 'reopened' })
  })

  it('detects inreview: to=inreview', () => {
    const old = [makeIssue('abc-001', 'in_progress')]
    const fresh = [makeIssue('abc-001', 'inreview')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'statusTransition', toastKey: 'inreview' })
  })

  it('detects blocked: to=blocked', () => {
    const old = [makeIssue('abc-001', 'open')]
    const fresh = [makeIssue('abc-001', 'blocked')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'statusTransition', toastKey: 'blocked' })
  })

  it('detects in_progress: from=open to=in_progress', () => {
    const old = [makeIssue('abc-001', 'open')]
    const fresh = [makeIssue('abc-001', 'in_progress')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'statusTransition', toastKey: 'inProgress' })
  })

  it('produces null toastKey for non-noteworthy transition (open → deferred)', () => {
    const old = [makeIssue('abc-001', 'open')]
    const fresh = [makeIssue('abc-001', 'deferred')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'statusTransition', toastKey: null })
  })

  it('produces 0 events for field-only change (title, status unchanged)', () => {
    const old = [makeIssue('abc-001', 'open', 'Old Title')]
    const fresh = [makeIssue('abc-001', 'open', 'New Title')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(0)
  })

  it('produces 0 events when nothing changed (no-op)', () => {
    const old = [makeIssue('abc-001', 'open')]
    const fresh = [makeIssue('abc-001', 'open')]
    const events = computeNotifyEvents(old, fresh)
    expect(events).toHaveLength(0)
  })

  it('handles multiple issues simultaneously', () => {
    const old = [
      makeIssue('abc-001', 'open'),
      makeIssue('abc-002', 'in_progress'),
    ]
    const fresh = [
      makeIssue('abc-001', 'closed'),
      makeIssue('abc-003', 'open'),
    ]
    const events = computeNotifyEvents(old, fresh)
    // abc-001: statusTransition open→closed
    // abc-002: deleted
    // abc-003: created
    expect(events).toHaveLength(3)
    const kinds = events.map(e => e.kind).sort()
    expect(kinds).toEqual(['created', 'deleted', 'statusTransition'])
  })
})
