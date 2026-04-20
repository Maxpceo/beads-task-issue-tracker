import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import type { Issue } from '~/types/issue'

// ---------------------------------------------------------------------------
// Helpers
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
// Mocks
// ---------------------------------------------------------------------------
const mockProjects = ref<{ path: string; name: string; addedAt: string }[]>([])

vi.mock('~/composables/useFavorites', () => ({
  useFavorites: () => ({ projects: mockProjects }),
}))

const mockBdList = vi.fn()
vi.mock('~/utils/bd-api', () => ({
  bdList: (...args: unknown[]) => mockBdList(...args),
  logFrontend: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Import composable AFTER mocks (singleton is stable)
// ---------------------------------------------------------------------------
// NOTE: useCommandPalette uses module-level singleton. We reset state between
// tests by calling closePalette() and manually clearing allResults via refresh.
import { useCommandPalette } from '~/composables/useCommandPalette'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('useCommandPalette', () => {
  beforeEach(async () => {
    mockProjects.value = []
    mockBdList.mockReset()
    vi.clearAllTimers()

    // Reset singleton state: close palette, clear allResults
    const { closePalette, allResults, errors, loading } = useCommandPalette()
    closePalette()
    allResults.value = []
    errors.value = []
    loading.value = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('open/close resets query and focusedIndex', async () => {
    const { open, query, focusedIndex, openPalette, closePalette } = useCommandPalette()
    mockProjects.value = []

    // Mock bdList to avoid real calls during TTL check
    mockBdList.mockResolvedValue([])

    openPalette()
    expect(open.value).toBe(true)

    query.value = 'something'
    focusedIndex.value = 3

    closePalette()
    expect(open.value).toBe(false)
    expect(query.value).toBe('')
    expect(focusedIndex.value).toBe(0)
  })

  it('empty projects → no fan-out, results empty after query', async () => {
    const { openPalette, refresh, query, results } = useCommandPalette()
    mockProjects.value = []

    openPalette()
    await refresh()

    expect(mockBdList).not.toHaveBeenCalled()
    query.value = 'anything'
    expect(results.value).toHaveLength(0)
  })

  it('cross-project merge: 2 projects × 3 issues → 6 results in allResults before filter', async () => {
    const issuesA = [
      makeIssue({ id: 'proj-a-1', title: 'Alpha one' }),
      makeIssue({ id: 'proj-a-2', title: 'Alpha two' }),
      makeIssue({ id: 'proj-a-3', title: 'Alpha three' }),
    ]
    const issuesB = [
      makeIssue({ id: 'proj-b-1', title: 'Beta one' }),
      makeIssue({ id: 'proj-b-2', title: 'Beta two' }),
      makeIssue({ id: 'proj-b-3', title: 'Beta three' }),
    ]

    mockProjects.value = [
      { path: '/projects/a', name: 'a', addedAt: '' },
      { path: '/projects/b', name: 'b', addedAt: '' },
    ]
    mockBdList
      .mockResolvedValueOnce(issuesA)
      .mockResolvedValueOnce(issuesB)

    const { openPalette, refresh, allResults } = useCommandPalette()
    openPalette()
    await refresh()

    expect(allResults.value).toHaveLength(6)
  })

  it('Promise.allSettled: one project rejects → other results still returned, errors.length===1', async () => {
    const issuesA = [
      makeIssue({ id: 'proj-a-1', title: 'Alpha one' }),
      makeIssue({ id: 'proj-a-2', title: 'Alpha two' }),
      makeIssue({ id: 'proj-a-3', title: 'Alpha three' }),
    ]

    mockProjects.value = [
      { path: '/projects/a', name: 'a', addedAt: '' },
      { path: '/projects/b-broken', name: 'b', addedAt: '' },
    ]
    mockBdList
      .mockResolvedValueOnce(issuesA)
      .mockRejectedValueOnce(new Error('ENOENT'))

    const { openPalette, refresh, allResults, errors } = useCommandPalette()
    openPalette()
    await refresh()

    expect(allResults.value).toHaveLength(3)
    expect(errors.value).toHaveLength(1)
  })

  it('ranking: last-segment id match ("nif") ranks above title-contains', async () => {
    const issues = [
      makeIssue({ id: 'beads-task-issue-tracker-nif', title: 'unrelated title', updatedAt: '2025-01-02T00:00:00Z' }),
      makeIssue({ id: 'other-issue-xyz', title: 'nif in title only', updatedAt: '2025-01-03T00:00:00Z' }),
    ]

    mockProjects.value = [{ path: '/p', name: 'p', addedAt: '' }]
    mockBdList.mockResolvedValueOnce(issues)

    const { openPalette, refresh, query, results } = useCommandPalette()
    openPalette()
    await refresh()

    query.value = 'nif'

    // rank 2 (last-segment) for first, rank 5 (title-contains) for second
    expect(results.value[0]!.issue.id).toBe('beads-task-issue-tracker-nif')
    expect(results.value[1]!.issue.id).toBe('other-issue-xyz')
  })

  it('TTL 30s: second openPalette within window skips refresh', async () => {
    mockProjects.value = [{ path: '/p', name: 'p', addedAt: '' }]
    mockBdList.mockResolvedValue([makeIssue()])

    const { openPalette, refresh } = useCommandPalette()

    // First open: force TTL miss by refresh directly
    await refresh()
    const callsAfterFirst = mockBdList.mock.calls.length
    expect(callsAfterFirst).toBe(1)

    // Simulate lastRefreshAt being recent (within 30s window)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 1000) // +1s from refresh time

    // Second open — within TTL, openPalette should not trigger another fan-out
    // openPalette only calls refresh() when ttlExpired = Date.now() - lastRefreshAt > 30_000
    // Since we set Date.now to +1s and lastRefreshAt was set during refresh(), delta = ~1s < 30s
    openPalette()
    await new Promise(r => setTimeout(r, 10))

    // Still only 1 bdList call
    expect(mockBdList).toHaveBeenCalledTimes(1)
  })

  it('results are limited to 50', async () => {
    const manyIssues = Array.from({ length: 100 }, (_, i) =>
      makeIssue({ id: `issue-${i}`, title: `searchable topic ${i}` })
    )

    mockProjects.value = [{ path: '/p', name: 'p', addedAt: '' }]
    mockBdList.mockResolvedValueOnce(manyIssues)

    const { openPalette, refresh, query, results } = useCommandPalette()
    openPalette()
    await refresh()

    query.value = 'topic'
    expect(results.value.length).toBeLessThanOrEqual(50)
  })

  it('onArrowDown / onArrowUp wrap focusedIndex', async () => {
    const issues = [
      makeIssue({ id: 'a-alpha', title: 'search alpha' }),
      makeIssue({ id: 'a-beta', title: 'search beta' }),
    ]

    mockProjects.value = [{ path: '/p', name: 'p', addedAt: '' }]
    mockBdList.mockResolvedValueOnce(issues)

    const { openPalette, refresh, query, focusedIndex, onArrowDown, onArrowUp } = useCommandPalette()
    openPalette()
    await refresh()
    query.value = 'search'

    // results should have 2 items, initial index = 0
    expect(focusedIndex.value).toBe(0)

    onArrowDown()
    expect(focusedIndex.value).toBe(1)

    // Wrap at end
    onArrowDown()
    expect(focusedIndex.value).toBe(0)

    // Wrap at beginning
    onArrowUp()
    expect(focusedIndex.value).toBe(1)
  })
})
