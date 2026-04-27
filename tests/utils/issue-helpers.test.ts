import { describe, it, expect } from 'vitest'
import type { Issue } from '~/types/issue'
import {
  deduplicateIssues,
  linkParentsAndChildren,
  naturalCompare,
  getParentIdFromIssue,
  compareChildIssues,
  sortIssues,
  filterIssues,
  matchesSearch,
  groupIssues,
  pruneClosedBlockers,
  computeReadyIssues,
  statusOrder,
  priorityOrder,
  typeOrder,
  categoryRank,
} from '~/utils/issue-helpers'

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'test-1',
    title: 'Test issue',
    description: '',
    type: 'task',
    status: 'open',
    priority: 'p2',
    assignee: '',
    labels: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    comments: [],
    ...overrides,
  } as Issue
}

// ---------------------------------------------------------------------------
// deduplicateIssues
// ---------------------------------------------------------------------------
describe('deduplicateIssues', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicateIssues([])).toEqual([])
  })

  it('keeps unique issues as-is', () => {
    const issues = [makeIssue({ id: 'a' }), makeIssue({ id: 'b' })]
    expect(deduplicateIssues(issues)).toHaveLength(2)
  })

  it('keeps most recently updated when duplicates exist', () => {
    const old = makeIssue({ id: 'a', updatedAt: '2025-01-01T00:00:00Z', title: 'old' })
    const recent = makeIssue({ id: 'a', updatedAt: '2025-06-01T00:00:00Z', title: 'recent' })
    const result = deduplicateIssues([old, recent])
    expect(result).toHaveLength(1)
    expect(result[0]!.title).toBe('recent')
  })

  it('keeps first when dates are equal', () => {
    const first = makeIssue({ id: 'a', updatedAt: '2025-01-01T00:00:00Z', title: 'first' })
    const second = makeIssue({ id: 'a', updatedAt: '2025-01-01T00:00:00Z', title: 'second' })
    const result = deduplicateIssues([first, second])
    expect(result).toHaveLength(1)
    expect(result[0]!.title).toBe('first')
  })
})

// ---------------------------------------------------------------------------
// naturalCompare
// ---------------------------------------------------------------------------
describe('naturalCompare', () => {
  it('sorts simple strings alphabetically', () => {
    expect(naturalCompare('abc', 'def')).toBeLessThan(0)
    expect(naturalCompare('def', 'abc')).toBeGreaterThan(0)
    expect(naturalCompare('abc', 'abc')).toBe(0)
  })

  it('sorts numbers numerically, not lexicographically', () => {
    expect(naturalCompare('2', '10')).toBeLessThan(0)
    expect(naturalCompare('10', '2')).toBeGreaterThan(0)
  })

  it('handles mixed alpha-numeric strings', () => {
    const ids = ['item10', 'item2', 'item1', 'item20']
    ids.sort(naturalCompare)
    expect(ids).toEqual(['item1', 'item2', 'item10', 'item20'])
  })

  it('handles dot-notation IDs', () => {
    const ids = ['proj-40b.2', 'proj-40b.10', 'proj-40b.1']
    ids.sort(naturalCompare)
    expect(ids).toEqual(['proj-40b.1', 'proj-40b.2', 'proj-40b.10'])
  })

  it('handles empty strings', () => {
    expect(naturalCompare('', '')).toBe(0)
    expect(naturalCompare('', 'a')).toBeLessThan(0)
  })
})

// ---------------------------------------------------------------------------
// getParentIdFromIssue
// ---------------------------------------------------------------------------
describe('getParentIdFromIssue', () => {
  it('returns explicit parent ID when available', () => {
    const issue = makeIssue({ id: 'child-1', parent: { id: 'parent-1', title: 'P', status: 'open', priority: 'p2' } })
    expect(getParentIdFromIssue(issue)).toBe('parent-1')
  })

  it('derives parent from dot notation', () => {
    const issue = makeIssue({ id: 'proj-abc.3' })
    expect(getParentIdFromIssue(issue)).toBe('proj-abc')
  })

  it('returns null for top-level issue (no dot)', () => {
    const issue = makeIssue({ id: 'proj-abc' })
    expect(getParentIdFromIssue(issue)).toBeNull()
  })

  it('returns null when dot suffix is not numeric', () => {
    const issue = makeIssue({ id: 'proj-v1.beta' })
    expect(getParentIdFromIssue(issue)).toBeNull()
  })

  it('handles multi-level dots (uses last dot)', () => {
    const issue = makeIssue({ id: 'proj-abc.1.2' })
    expect(getParentIdFromIssue(issue)).toBe('proj-abc.1')
  })
})

// ---------------------------------------------------------------------------
// compareChildIssues
// ---------------------------------------------------------------------------
describe('compareChildIssues', () => {
  it('sorts by numeric suffix ascending', () => {
    const a = makeIssue({ id: 'epic.1' })
    const b = makeIssue({ id: 'epic.3' })
    const c = makeIssue({ id: 'epic.2' })
    const sorted = [a, b, c].sort(compareChildIssues)
    expect(sorted.map(i => i.id)).toEqual(['epic.1', 'epic.2', 'epic.3'])
  })

  it('puts suffixed IDs before non-suffixed', () => {
    const a = makeIssue({ id: 'epic.1' })
    const b = makeIssue({ id: 'no-suffix' })
    expect(compareChildIssues(a, b)).toBeLessThan(0)
  })

  it('falls back to createdAt for non-suffixed IDs', () => {
    const older = makeIssue({ id: 'a', createdAt: '2025-01-01T00:00:00Z' })
    const newer = makeIssue({ id: 'b', createdAt: '2025-06-01T00:00:00Z' })
    expect(compareChildIssues(older, newer)).toBeLessThan(0)
  })
})

// ---------------------------------------------------------------------------
// Sort orders
// ---------------------------------------------------------------------------
describe('sort orders', () => {
  it('status: in_progress < open < blocked < closed', () => {
    expect(statusOrder['in_progress']).toBeLessThan(statusOrder['open']!)
    expect(statusOrder['open']).toBeLessThan(statusOrder['blocked']!)
    expect(statusOrder['blocked']).toBeLessThan(statusOrder['closed']!)
  })

  it('priority: p0 < p1 < p2 < p3 < p4', () => {
    expect(priorityOrder['p0']).toBeLessThan(priorityOrder['p4']!)
  })

  it('type: bug < feature < task < epic < chore', () => {
    expect(typeOrder['bug']).toBeLessThan(typeOrder['chore']!)
  })
})

// ---------------------------------------------------------------------------
// sortIssues
// ---------------------------------------------------------------------------
describe('sortIssues', () => {
  const issues = [
    makeIssue({ id: 'z-3', status: 'open', priority: 'p2', updatedAt: '2025-03-01T00:00:00Z' }),
    makeIssue({ id: 'a-1', status: 'in_progress', priority: 'p0', updatedAt: '2025-01-01T00:00:00Z' }),
    makeIssue({ id: 'm-2', status: 'closed', priority: 'p4', updatedAt: '2025-02-01T00:00:00Z' }),
  ]

  it('returns input unchanged when field is null', () => {
    const result = sortIssues(issues, null, 'asc')
    expect(result).toBe(issues) // same reference
  })

  it('sorts by ID with natural sort', () => {
    const result = sortIssues(issues, 'id', 'asc')
    expect(result.map(i => i.id)).toEqual(['a-1', 'm-2', 'z-3'])
  })

  it('sorts by status using custom order', () => {
    const result = sortIssues(issues, 'status', 'asc')
    expect(result.map(i => i.status)).toEqual(['in_progress', 'open', 'closed'])
  })

  it('sorts by priority', () => {
    const result = sortIssues(issues, 'priority', 'asc')
    expect(result.map(i => i.priority)).toEqual(['p0', 'p2', 'p4'])
  })

  it('sorts by updatedAt', () => {
    const result = sortIssues(issues, 'updatedAt', 'desc')
    expect(result.map(i => i.id)).toEqual(['z-3', 'm-2', 'a-1'])
  })

  it('respects direction', () => {
    const asc = sortIssues(issues, 'id', 'asc')
    const desc = sortIssues(issues, 'id', 'desc')
    expect(asc.map(i => i.id)).toEqual(['a-1', 'm-2', 'z-3'])
    expect(desc.map(i => i.id)).toEqual(['z-3', 'm-2', 'a-1'])
  })

  it('does not mutate input array', () => {
    const copy = [...issues]
    sortIssues(issues, 'id', 'asc')
    expect(issues.map(i => i.id)).toEqual(copy.map(i => i.id))
  })

  it('sorts pinned issues before unpinned (asc)', () => {
    const a = makeIssue({ id: 'a' })
    const b = makeIssue({ id: 'b' })
    const c = makeIssue({ id: 'c' })
    const result = sortIssues([a, b, c], 'pinned', 'asc', ['b', 'c'])
    expect(result.map(i => i.id)).toEqual(['b', 'c', 'a'])
  })

  it('keeps pinned issues on top even in desc mode', () => {
    const a = makeIssue({ id: 'a', updatedAt: '2025-01-01T00:00:00Z' })
    const b = makeIssue({ id: 'b', updatedAt: '2025-01-02T00:00:00Z' })
    const c = makeIssue({ id: 'c', updatedAt: '2025-01-03T00:00:00Z' })
    const result = sortIssues([a, b, c], 'pinned', 'desc', ['b'])
    // Pinned (b) always on top; non-pinned sorted desc by updatedAt: c (Jan 3) then a (Jan 1)
    expect(result.map(i => i.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts pinned without pinnedIds as no-op (all equal)', () => {
    const a = makeIssue({ id: 'a' })
    const b = makeIssue({ id: 'b' })
    const result = sortIssues([a, b], 'pinned', 'asc')
    // All unpinned, falls back to natural ID sort
    expect(result.map(i => i.id)).toEqual(['a', 'b'])
  })

  it('pinned issues float to top regardless of sort field', () => {
    const a = makeIssue({ id: 'a', priority: 'p0' })
    const b = makeIssue({ id: 'b', priority: 'p3' })
    const c = makeIssue({ id: 'c', priority: 'p1' })
    // b is pinned but has lowest priority — should still be first
    const result = sortIssues([a, b, c], 'priority', 'asc', ['b'])
    expect(result[0]!.id).toBe('b')
    // Non-pinned sorted by priority asc: p0 (a) then p1 (c)
    expect(result[1]!.id).toBe('a')
    expect(result[2]!.id).toBe('c')
  })

  it('sorts issues without labels last when sorting by labels', () => {
    const withLabel = makeIssue({ id: 'b', labels: ['frontend'] })
    const noLabel = makeIssue({ id: 'a', labels: [] })
    const result = sortIssues([noLabel, withLabel], 'labels', 'asc')
    expect(result[0]!.id).toBe('b')
  })
})

// ---------------------------------------------------------------------------
// sortIssues — floatActive option
// ---------------------------------------------------------------------------
describe('sortIssues floatActive option', () => {
  // resolveCategory helper that maps status names to categories
  const resolveCategory = (status: string): string | undefined => {
    const map: Record<string, string> = {
      in_progress: 'wip',
      inreview: 'wip',
      open: 'active',
      blocked: 'frozen',
      closed: 'done',
    }
    return map[status]
  }

  it('floatActive: false → strict sort by field, no category interference', () => {
    const issues = [
      makeIssue({ id: 'a', status: 'closed', updatedAt: '2025-03-01T00:00:00Z' }),
      makeIssue({ id: 'b', status: 'in_progress', updatedAt: '2025-01-01T00:00:00Z' }),
      makeIssue({ id: 'c', status: 'open', updatedAt: '2025-02-01T00:00:00Z' }),
    ]
    const result = sortIssues(issues, 'updatedAt', 'desc', [], { floatActive: false, resolveCategory })
    // desc by updatedAt: a (Mar) → c (Feb) → b (Jan)
    expect(result.map(i => i.id)).toEqual(['a', 'c', 'b'])
  })

  it('floatActive: true → wip above active above frozen above done', () => {
    const issues = [
      makeIssue({ id: 'done-1', status: 'closed' }),
      makeIssue({ id: 'frozen-1', status: 'blocked' }),
      makeIssue({ id: 'active-1', status: 'open' }),
      makeIssue({ id: 'wip-1', status: 'in_progress' }),
    ]
    const result = sortIssues(issues, 'updatedAt', 'desc', [], { floatActive: true, resolveCategory })
    expect(result.map(i => i.id)).toEqual(['wip-1', 'active-1', 'frozen-1', 'done-1'])
  })

  it('unknown status with resolveCategory returning undefined → fallback rank active (1)', () => {
    const issues = [
      makeIssue({ id: 'unknown', status: 'custom_status' }), // resolveCategory returns undefined → rank 1 (active)
      makeIssue({ id: 'done', status: 'closed' }),            // rank 3 (done)
      makeIssue({ id: 'wip', status: 'in_progress' }),        // rank 0 (wip)
    ]
    const result = sortIssues(issues, 'updatedAt', 'desc', [], { floatActive: true, resolveCategory })
    // wip(0) → unknown→active fallback(1) → done(3)
    expect(result[0]!.id).toBe('wip')
    expect(result[1]!.id).toBe('unknown')
    expect(result[2]!.id).toBe('done')
  })

  it('floatActive: true + pinned IDs → pinned stays above wip', () => {
    const issues = [
      makeIssue({ id: 'wip-1', status: 'in_progress' }),
      makeIssue({ id: 'pinned-open', status: 'open' }),
      makeIssue({ id: 'done-1', status: 'closed' }),
    ]
    const result = sortIssues(issues, 'updatedAt', 'desc', ['pinned-open'], { floatActive: true, resolveCategory })
    expect(result[0]!.id).toBe('pinned-open') // pinned always tier 1
    expect(result[1]!.id).toBe('wip-1')       // wip tier 2
    expect(result[2]!.id).toBe('done-1')       // done tier last
  })

  it('inside wip category, user-sort by priority desc applies correctly', () => {
    const issues = [
      makeIssue({ id: 'wip-low', status: 'in_progress', priority: 'p3' }),
      makeIssue({ id: 'done-high', status: 'closed', priority: 'p0' }),
      makeIssue({ id: 'wip-high', status: 'in_progress', priority: 'p0' }),
    ]
    const result = sortIssues(issues, 'priority', 'asc', [], { floatActive: true, resolveCategory })
    // wip partition: wip-high(p0) before wip-low(p3); done partition: done-high(p0)
    expect(result[0]!.id).toBe('wip-high')
    expect(result[1]!.id).toBe('wip-low')
    expect(result[2]!.id).toBe('done-high')
  })

  it('no options param passed → backward compatible, sorts without category interference', () => {
    const issues = [
      makeIssue({ id: 'a', status: 'closed', updatedAt: '2025-03-01T00:00:00Z' }),
      makeIssue({ id: 'b', status: 'in_progress', updatedAt: '2025-01-01T00:00:00Z' }),
    ]
    const result = sortIssues(issues, 'updatedAt', 'desc')
    expect(result.map(i => i.id)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// filterIssues
// ---------------------------------------------------------------------------
describe('filterIssues', () => {
  const noFilters = { status: [] as string[], type: [] as string[], priority: [] as string[], assignee: [] as string[], search: '', labels: [] as string[] }
  const noExclusions = { status: [] as string[], priority: [] as string[], type: [] as string[], labels: [] as string[], assignee: [] as string[] }

  const issues = [
    makeIssue({ id: '1', title: 'Login bug', status: 'open', type: 'bug', priority: 'p0', labels: ['frontend'], assignee: 'alice' }),
    makeIssue({ id: '2', title: 'Add tests', status: 'in_progress', type: 'task', priority: 'p2', labels: ['backend'], assignee: 'bob' }),
    makeIssue({ id: '3', title: 'Old feature', status: 'closed', type: 'feature', priority: 'p3' }),
  ]

  it('uses workflow view by default (no status filter)', () => {
    const result = filterIssues(issues, noFilters, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1', '2'])
  })

  it('default workflow view includes blocked statuses and dependency-blocked issues (excludes only closed/deleted/tombstone)', () => {
    const dependencyBlocked = makeIssue({ id: '5', status: 'open', blockedBy: ['1'] })
    const explicitlyBlocked = makeIssue({ id: '6', status: 'blocked' })
    const result = filterIssues([...issues, dependencyBlocked, explicitlyBlocked], noFilters, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1', '2', '5', '6'])
  })

  it('shows only selected statuses when status filter active', () => {
    const result = filterIssues(issues, { ...noFilters, status: ['closed'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['3'])
  })

  it('returns every supported status when all status filters are selected (TOTAL view)', () => {
    const fullStatusSet = [
      ...issues,
      makeIssue({ id: '4', status: 'blocked' }),
      makeIssue({ id: '5', status: 'deferred' }),
      makeIssue({ id: '6', status: 'pinned' }),
      makeIssue({ id: '7', status: 'hooked' }),
    ]

    const result = filterIssues(
      fullStatusSet,
      {
        ...noFilters,
        status: ['open', 'in_progress', 'blocked', 'closed', 'deferred', 'pinned', 'hooked'],
      },
      noExclusions,
    )

    expect(result.map(i => i.id)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  })

  it('includes dependency-blocked issues in blocked status filter', () => {
    const dependencyBlocked = makeIssue({ id: '5', status: 'open', blockedBy: ['1'] })
    const explicitlyBlocked = makeIssue({ id: '6', status: 'blocked' })
    const result = filterIssues(
      [...issues, dependencyBlocked, explicitlyBlocked],
      { ...noFilters, status: ['blocked'] },
      noExclusions,
    )
    expect(result.map(i => i.id)).toEqual(['5', '6'])
  })

  it('excludes dependency-blocked issues from open status filter', () => {
    const dependencyBlocked = makeIssue({ id: '5', status: 'open', blockedBy: ['1'] })
    const result = filterIssues(
      [...issues, dependencyBlocked],
      { ...noFilters, status: ['open'] },
      noExclusions,
    )
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('filters by type', () => {
    const result = filterIssues(issues, { ...noFilters, type: ['bug'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('filters by priority', () => {
    const result = filterIssues(issues, { ...noFilters, priority: ['p0'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('filters by assignee', () => {
    const result = filterIssues(issues, { ...noFilters, assignee: ['bob'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['2'])
  })

  it('filters by labels (OR logic)', () => {
    const result = filterIssues(issues, { ...noFilters, labels: ['backend'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['2'])
  })

  it('label matching is case-insensitive', () => {
    const result = filterIssues(issues, { ...noFilters, labels: ['FRONTEND'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  // Search semantics: активный search игнорирует ВСЕ фильтры и exclusions
  // (global-search Jira/Linear). Пустой search → фильтры работают как обычно.

  it('search игнорирует дефолтный workflow-фильтр и находит closed задачу', () => {
    const result = filterIssues(issues, { ...noFilters, search: 'old feature' }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['3'])
  })

  it('search игнорирует status filter', () => {
    const result = filterIssues(issues, { ...noFilters, status: ['open'], search: 'old feature' }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['3'])
  })

  it('search игнорирует type filter', () => {
    const result = filterIssues(issues, { ...noFilters, search: 'Login', type: ['task'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('search игнорирует priority filter', () => {
    const result = filterIssues(issues, { ...noFilters, search: 'Login', priority: ['p2'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('search игнорирует labels filter', () => {
    const result = filterIssues(issues, { ...noFilters, search: 'Login', labels: ['backend'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('search игнорирует assignee filter', () => {
    const result = filterIssues(issues, { ...noFilters, search: 'Login', assignee: ['bob'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('search игнорирует exclusions (priority/labels/assignee/status)', () => {
    const result = filterIssues(
      issues,
      { ...noFilters, search: 'Login' },
      { status: ['open'], priority: ['p0'], type: ['bug'], labels: ['frontend'], assignee: ['alice'] },
    )
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('search matches title', () => {
    const result = filterIssues(issues, { ...noFilters, search: 'Login' }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('search matches id', () => {
    const custom = [makeIssue({ id: 'bead-xyz-123', title: 'Nothing' })]
    const result = filterIssues(custom, { ...noFilters, search: 'xyz' }, noExclusions)
    expect(result).toHaveLength(1)
  })

  it('search matches description', () => {
    const withDesc = [makeIssue({ id: 'x', title: 'Nothing', description: 'hidden keyword' })]
    const result = filterIssues(withDesc, { ...noFilters, search: 'keyword' }, noExclusions)
    expect(result).toHaveLength(1)
  })

  it('search matches label', () => {
    const result = filterIssues(issues, { ...noFilters, search: 'backend' }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['2'])
  })

  it('search case-insensitive для всех полей', () => {
    const mixed = [
      makeIssue({ id: 'a', title: 'UPPERCASE TITLE' }),
      makeIssue({ id: 'b', title: 'Nothing', description: 'MiXeD CaSe DeScRiPtIoN' }),
    ]
    expect(filterIssues(mixed, { ...noFilters, search: 'uppercase' }, noExclusions)).toHaveLength(1)
    expect(filterIssues(mixed, { ...noFilters, search: 'MIXED CASE' }, noExclusions)).toHaveLength(1)
  })

  it('пустой search → фильтры работают как обычно (обратная совместимость)', () => {
    const result = filterIssues(issues, { ...noFilters, status: ['open'] }, noExclusions)
    expect(result.map(i => i.id)).toEqual(['1'])
  })

  it('applies exclusion filters', () => {
    const result = filterIssues(issues, noFilters, { ...noExclusions, priority: ['p0'] })
    expect(result.map(i => i.id)).toEqual(['2'])
  })

  it('status exclusion for blocked removes dependency-blocked issues', () => {
    const dependencyBlocked = makeIssue({ id: '5', status: 'open', blockedBy: ['1'] })
    const result = filterIssues(
      [...issues, dependencyBlocked],
      noFilters,
      { ...noExclusions, status: ['blocked'] },
    )
    expect(result.map(i => i.id)).toEqual(['1', '2'])
  })

  it('excludes by label', () => {
    const result = filterIssues(issues, noFilters, { ...noExclusions, labels: ['frontend'] })
    expect(result.map(i => i.id)).toEqual(['2'])
  })

  it('excludes by assignee', () => {
    const result = filterIssues(issues, noFilters, { ...noExclusions, assignee: ['alice'] })
    expect(result.map(i => i.id)).toEqual(['2'])
  })

  it('returns all workflow issues when no filters and no exclusions', () => {
    const result = filterIssues(issues, noFilters, noExclusions)
    expect(result).toHaveLength(2)
  })

  it('returns empty when no issues match', () => {
    const result = filterIssues(issues, { ...noFilters, search: 'nonexistent' }, noExclusions)
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// groupIssues
// ---------------------------------------------------------------------------
describe('groupIssues', () => {
  it('returns empty array for empty input', () => {
    expect(groupIssues([], [])).toEqual([])
  })

  it('groups epic with its children', () => {
    const epic = makeIssue({ id: 'epic-1', type: 'epic' })
    const child1 = makeIssue({ id: 'epic-1.1', type: 'task', parent: { id: 'epic-1', title: 'E', status: 'open', priority: 'p2' } })
    const child2 = makeIssue({ id: 'epic-1.2', type: 'task', parent: { id: 'epic-1', title: 'E', status: 'open', priority: 'p2' } })
    const all = [epic, child1, child2]

    const result = groupIssues(all, all)
    expect(result).toHaveLength(1)
    expect(result[0]!.epic!.id).toBe('epic-1')
    expect(result[0]!.children).toHaveLength(2)
    expect(result[0]!.childCount).toBe(2)
  })

  it('puts non-epic, non-child issues as orphans', () => {
    const standalone = makeIssue({ id: 'standalone', type: 'task' })
    const result = groupIssues([standalone], [standalone])
    expect(result).toHaveLength(1)
    expect(result[0]!.epic).toBeNull()
    expect(result[0]!.children).toEqual([standalone])
  })

  it('counts closed children from allIssues', () => {
    const epic = makeIssue({ id: 'e', type: 'epic' })
    const openChild = makeIssue({ id: 'e.1', status: 'open', parent: { id: 'e', title: '', status: 'open', priority: 'p2' } })
    const closedChild = makeIssue({ id: 'e.2', status: 'closed', parent: { id: 'e', title: '', status: 'open', priority: 'p2' } })
    const all = [epic, openChild, closedChild]

    // Only epic and openChild are visible (paginated)
    const result = groupIssues([epic, openChild], all)
    expect(result[0]!.childCount).toBe(2)
    expect(result[0]!.closedChildCount).toBe(1)
    expect(result[0]!.children).toHaveLength(1) // only visible children
  })

  it('detects in-progress child', () => {
    const epic = makeIssue({ id: 'e', type: 'epic' })
    const child = makeIssue({ id: 'e.1', status: 'in_progress', priority: 'p1', parent: { id: 'e', title: '', status: 'open', priority: 'p2' } })
    const all = [epic, child]

    const result = groupIssues(all, all)
    expect(result[0]!.inProgressChild).toEqual({ id: 'e.1', title: 'Test issue', priority: 'p1' })
  })

  it('sorts children by numeric suffix', () => {
    const epic = makeIssue({ id: 'e', type: 'epic' })
    const c3 = makeIssue({ id: 'e.3', parent: { id: 'e', title: '', status: 'open', priority: 'p2' } })
    const c1 = makeIssue({ id: 'e.1', parent: { id: 'e', title: '', status: 'open', priority: 'p2' } })
    const c2 = makeIssue({ id: 'e.2', parent: { id: 'e', title: '', status: 'open', priority: 'p2' } })
    const all = [epic, c3, c1, c2]

    const result = groupIssues(all, all)
    expect(result[0]!.children.map(c => c.id)).toEqual(['e.1', 'e.2', 'e.3'])
  })

  // --- Orphan epic wrapper tests ---

  it('shows epic wrapper when epic itself is filtered out but children are visible', () => {
    const epic = makeIssue({ id: 'epic-1', type: 'epic', status: 'open' })
    const child1 = makeIssue({ id: 'epic-1.1', status: 'in_progress', parent: { id: 'epic-1', title: 'E', status: 'open', priority: 'p2' } })
    const child2 = makeIssue({ id: 'epic-1.2', status: 'closed', parent: { id: 'epic-1', title: 'E', status: 'open', priority: 'p2' } })
    const allIssues = [epic, child1, child2]
    // Simulate "In Progress" KPI filter: only child1 passes
    const paginated = [child1]

    const result = groupIssues(paginated, allIssues)
    expect(result).toHaveLength(1)
    expect(result[0]!.epic!.id).toBe('epic-1')
    expect(result[0]!.children).toHaveLength(1)
    expect(result[0]!.children[0]!.id).toBe('epic-1.1')
    expect(result[0]!.childCount).toBe(2)
    expect(result[0]!.closedChildCount).toBe(1)
  })

  it('places orphaned epic wrapper at position of first visible child', () => {
    const epic = makeIssue({ id: 'epic-1', type: 'epic', status: 'open' })
    const standaloneA = makeIssue({ id: 'standalone-a', type: 'task' })
    const child = makeIssue({ id: 'epic-1.1', status: 'in_progress', parent: { id: 'epic-1', title: 'E', status: 'open', priority: 'p2' } })
    const standaloneB = makeIssue({ id: 'standalone-b', type: 'task' })
    const allIssues = [standaloneA, epic, child, standaloneB]
    // Epic absent from paginated; child is in the middle
    const paginated = [standaloneA, child, standaloneB]

    const result = groupIssues(paginated, allIssues)
    expect(result).toHaveLength(3)
    expect(result[0]!.epic).toBeNull()
    expect(result[0]!.children[0]!.id).toBe('standalone-a')
    expect(result[1]!.epic!.id).toBe('epic-1')
    expect(result[2]!.epic).toBeNull()
    expect(result[2]!.children[0]!.id).toBe('standalone-b')
  })

  it('does not duplicate epic wrapper when multiple children are visible', () => {
    const epic = makeIssue({ id: 'epic-1', type: 'epic', status: 'open' })
    const child1 = makeIssue({ id: 'epic-1.1', status: 'in_progress', parent: { id: 'epic-1', title: 'E', status: 'open', priority: 'p2' } })
    const child2 = makeIssue({ id: 'epic-1.2', status: 'in_progress', parent: { id: 'epic-1', title: 'E', status: 'open', priority: 'p2' } })
    const allIssues = [epic, child1, child2]
    const paginated = [child1, child2]

    const result = groupIssues(paginated, allIssues)
    expect(result).toHaveLength(1)
    expect(result[0]!.epic!.id).toBe('epic-1')
    expect(result[0]!.children).toHaveLength(2)
  })

  it('falls back to standalone when child references missing epic in allIssues', () => {
    // Epic with id 'epic-missing' is NOT in allIssues
    const child = makeIssue({ id: 'orphan-child', status: 'in_progress', parent: { id: 'epic-missing', title: 'E', status: 'open', priority: 'p2' } })
    const allIssues = [child] // no epic object

    const result = groupIssues([child], allIssues)
    expect(result).toHaveLength(1)
    expect(result[0]!.epic).toBeNull()
    expect(result[0]!.children[0]!.id).toBe('orphan-child')
  })

  it('treats child of non-epic parent as standalone', () => {
    const parentTask = makeIssue({ id: 'parent-task', type: 'task', status: 'open' })
    const child = makeIssue({ id: 'child-task', type: 'task', status: 'in_progress', parent: { id: 'parent-task', title: 'P', status: 'open', priority: 'p2' } })
    const allIssues = [parentTask, child]
    const paginated = [child]

    const result = groupIssues(paginated, allIssues)
    expect(result).toHaveLength(1)
    expect(result[0]!.epic).toBeNull()
    expect(result[0]!.children[0]!.id).toBe('child-task')
  })

  it('groups two orphaned epics with interleaved children correctly', () => {
    const epicA = makeIssue({ id: 'epic-a', type: 'epic', status: 'open' })
    const epicB = makeIssue({ id: 'epic-b', type: 'epic', status: 'open' })
    const a1 = makeIssue({ id: 'epic-a.1', status: 'in_progress', parent: { id: 'epic-a', title: 'A', status: 'open', priority: 'p2' } })
    const a2 = makeIssue({ id: 'epic-a.2', status: 'in_progress', parent: { id: 'epic-a', title: 'A', status: 'open', priority: 'p2' } })
    const b1 = makeIssue({ id: 'epic-b.1', status: 'in_progress', parent: { id: 'epic-b', title: 'B', status: 'open', priority: 'p2' } })
    const allIssues = [epicA, epicB, a1, b1, a2]
    // Both epics absent; children interleaved
    const paginated = [a1, b1, a2]

    const result = groupIssues(paginated, allIssues)
    expect(result).toHaveLength(2)
    // First group: epicA wrapper at position of a1
    expect(result[0]!.epic!.id).toBe('epic-a')
    expect(result[0]!.children.map(c => c.id)).toContain('epic-a.1')
    expect(result[0]!.children.map(c => c.id)).toContain('epic-a.2')
    // Second group: epicB wrapper at position of b1
    expect(result[1]!.epic!.id).toBe('epic-b')
    expect(result[1]!.children[0]!.id).toBe('epic-b.1')
  })
})

// ---------------------------------------------------------------------------
// pruneClosedBlockers
// ---------------------------------------------------------------------------
describe('pruneClosedBlockers', () => {
  it('removes closed blockers from blockedBy and blocks', () => {
    const issues = [
      makeIssue({ id: 'open-1', status: 'open', blockedBy: ['closed-1', 'open-2'] }),
      makeIssue({ id: 'open-2', status: 'open', blocks: ['open-1', 'closed-1'] }),
      makeIssue({ id: 'closed-1', status: 'closed' }),
    ]

    pruneClosedBlockers(issues)

    expect(issues[0]!.blockedBy).toEqual(['open-2'])
    expect(issues[1]!.blocks).toEqual(['open-1'])
  })

  it('clears dependency arrays when all references are closed', () => {
    const issues = [
      makeIssue({ id: 'open-1', status: 'open', blockedBy: ['closed-1'] }),
      makeIssue({ id: 'open-2', status: 'open', blocks: ['closed-1'] }),
      makeIssue({ id: 'closed-1', status: 'closed' }),
    ]

    pruneClosedBlockers(issues)

    expect(issues[0]!.blockedBy).toBeUndefined()
    expect(issues[1]!.blocks).toBeUndefined()
  })

  it('keeps unknown blocker IDs untouched', () => {
    const issues = [
      makeIssue({ id: 'open-1', status: 'open', blockedBy: ['missing-1'] }),
      makeIssue({ id: 'open-2', status: 'open' }),
    ]

    pruneClosedBlockers(issues)

    expect(issues[0]!.blockedBy).toEqual(['missing-1'])
  })
})

// ---------------------------------------------------------------------------
// linkParentsAndChildren
// ---------------------------------------------------------------------------
describe('linkParentsAndChildren', () => {
  it('derives parent from dot-notation ID and aggregates children on epic', () => {
    const issues = [
      makeIssue({ id: 'abc', type: 'epic', title: 'Epic A' }),
      makeIssue({ id: 'abc.1', title: 'Child 1' }),
      makeIssue({ id: 'abc.2', title: 'Child 2', priority: 'p0' }),
    ]

    linkParentsAndChildren(issues)

    expect(issues[1]!.parent).toEqual({ id: 'abc', title: 'Epic A', status: 'open', priority: 'p2' })
    expect(issues[2]!.parent?.id).toBe('abc')
    expect(issues[0]!.children).toHaveLength(2)
    expect(issues[0]!.children?.map(c => c.id)).toEqual(['abc.1', 'abc.2'])
    expect(issues[0]!.children?.[1]).toEqual({ id: 'abc.2', title: 'Child 2', status: 'open', priority: 'p0' })
  })

  it('enriches explicit parent link with loaded data', () => {
    const issues = [
      makeIssue({ id: 'epic1', type: 'epic', title: 'Fresh Title', status: 'in_progress' }),
      makeIssue({ id: 'child1', parent: { id: 'epic1', title: 'Stale', status: 'open', priority: 'p2' } as any }),
    ]

    linkParentsAndChildren(issues)

    expect(issues[1]!.parent?.title).toBe('Fresh Title')
    expect(issues[1]!.parent?.status).toBe('in_progress')
  })

  it('leaves issues untouched when parent is not in the array', () => {
    const issues = [makeIssue({ id: 'orphan.1' })]
    linkParentsAndChildren(issues)
    expect(issues[0]!.parent).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// computeReadyIssues
// ---------------------------------------------------------------------------
describe('computeReadyIssues', () => {
  it('returns open issues without blockers', () => {
    const issues = [
      makeIssue({ id: '1', status: 'open' }),
      makeIssue({ id: '2', status: 'open' }),
    ]
    expect(computeReadyIssues(issues).map(i => i.id)).toEqual(['1', '2'])
  })

  it('excludes issues with blockedBy', () => {
    const issues = [
      makeIssue({ id: '1', status: 'open' }),
      makeIssue({ id: '2', status: 'open', blockedBy: ['1'] }),
    ]
    expect(computeReadyIssues(issues).map(i => i.id)).toEqual(['1'])
  })

  it('excludes non-open statuses', () => {
    const issues = [
      makeIssue({ id: '1', status: 'open' }),
      makeIssue({ id: '2', status: 'in_progress' }),
      makeIssue({ id: '3', status: 'closed' }),
      makeIssue({ id: '4', status: 'blocked' }),
    ]
    expect(computeReadyIssues(issues).map(i => i.id)).toEqual(['1'])
  })

  it('treats empty blockedBy as not blocked', () => {
    const issues = [
      makeIssue({ id: '1', status: 'open', blockedBy: [] }),
    ]
    expect(computeReadyIssues(issues)).toHaveLength(1)
  })

  it('returns empty array for empty input', () => {
    expect(computeReadyIssues([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// matchesSearch
// ---------------------------------------------------------------------------
describe('matchesSearch', () => {
  it('returns false for empty term', () => {
    const issue = makeIssue({ id: 'abc-1', title: 'hello' })
    expect(matchesSearch(issue, '')).toBe(false)
  })

  it('matches by id (lowercase contains)', () => {
    const issue = makeIssue({ id: 'beads-task-nif', title: 'irrelevant' })
    expect(matchesSearch(issue, 'nif')).toBe(true)
    expect(matchesSearch(issue, 'xyz')).toBe(false)
  })

  it('matches by title (case-insensitive)', () => {
    const issue = makeIssue({ title: 'Add Command Palette' })
    expect(matchesSearch(issue, 'command')).toBe(true)
    expect(matchesSearch(issue, 'PALETTE')).toBe(false) // term is already lowercased
    expect(matchesSearch(issue, 'palette')).toBe(true)
  })

  it('matches by description', () => {
    const issue = makeIssue({ description: 'Implements cross-project search' })
    expect(matchesSearch(issue, 'cross-project')).toBe(true)
    expect(matchesSearch(issue, 'unrelated')).toBe(false)
  })

  it('matches by labels', () => {
    const issue = makeIssue({ labels: ['frontend', 'ui'] })
    expect(matchesSearch(issue, 'frontend')).toBe(true)
    expect(matchesSearch(issue, 'ui')).toBe(true)
    expect(matchesSearch(issue, 'backend')).toBe(false)
  })

  it('matches by workingNotes', () => {
    const issue = makeIssue({ workingNotes: 'Need to investigate palette TTL' })
    expect(matchesSearch(issue, 'ttl')).toBe(true)
    expect(matchesSearch(issue, 'irrelevant')).toBe(false)
  })

  it('matches by acceptanceCriteria', () => {
    const issue = makeIssue({ acceptanceCriteria: 'Cmd+K opens modal with results' })
    expect(matchesSearch(issue, 'opens modal')).toBe(true)
    expect(matchesSearch(issue, 'nope')).toBe(false)
  })

  it('matches by designNotes', () => {
    const issue = makeIssue({ designNotes: 'Use Reka-UI Dialog for focus-trap' })
    expect(matchesSearch(issue, 'reka-ui')).toBe(true)
    expect(matchesSearch(issue, 'something else')).toBe(false)
  })

  it('matches by comments content', () => {
    const issue = makeIssue({
      comments: [
        { id: 'c1', author: 'bot', content: 'LEARNED: ranking logic applied', createdAt: '' },
        { id: 'c2', author: 'human', content: 'looks good', createdAt: '' },
      ],
    })
    expect(matchesSearch(issue, 'ranking')).toBe(true)
    expect(matchesSearch(issue, 'looks good')).toBe(true)
    expect(matchesSearch(issue, 'unrelated')).toBe(false)
  })

  it('handles undefined optional fields gracefully', () => {
    const issue = makeIssue({
      id: 'no-match-id',
      title: 'No match title',
      description: undefined as unknown as string,
      workingNotes: undefined,
      acceptanceCriteria: undefined,
      designNotes: undefined,
      comments: [],
    })
    // Term that exists in none of the fields
    expect(matchesSearch(issue, 'xyzzy')).toBe(false)
  })

  it('handles unicode in term and content', () => {
    const issue = makeIssue({ title: 'Добавить палитру команд' })
    expect(matchesSearch(issue, 'палитру')).toBe(true)
    expect(matchesSearch(issue, 'palette')).toBe(false)
  })
})
