import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Issue } from '~/types/issue'
import { makeDeferred } from '../helpers/deferred'

// Reactive beadsPath — allows mutating mid-promise to simulate project switch
const beadsPathRef = ref('/proj/A')

vi.mock('~/composables/useBeadsPath', () => ({
  useBeadsPath: () => ({ beadsPath: beadsPathRef, hasStoredPath: ref(true) }),
}))

vi.mock('~/utils/bd-api', () => ({
  bdReady: vi.fn().mockResolvedValue([]),
  logFrontend: vi.fn().mockReturnValue(Promise.resolve()),
}))

vi.mock('~/utils/issue-helpers', () => ({
  computeStatsFromIssues: vi.fn().mockReturnValue({
    open: 0, closed: 0, inProgress: 0, ready: 0, total: 0,
    byPriority: {}, byType: {}, byAssignee: {},
  }),
}))

vi.mock('~/composables/useStatuses', () => ({
  useStatuses: () => ({
    statuses: { value: [] },
    getMeta: vi.fn().mockReturnValue(null),
  }),
}))

vi.mock('~/composables/useExclusionFilters', () => ({
  useExclusionFilters: () => ({ exclusions: { value: { labels: [] } } }),
}))

// Nuxt auto-imports stubs — Vue primitives and composables
import { ref as vueRef, computed as vueComputed, watch as vueWatch } from 'vue'
;(globalThis as Record<string, unknown>).ref ??= vueRef
;(globalThis as Record<string, unknown>).computed ??= vueComputed
;(globalThis as Record<string, unknown>).watch ??= vueWatch
;(globalThis as Record<string, unknown>).useStatuses ??= () => ({
  statuses: { value: [] },
  getMeta: vi.fn().mockReturnValue(null),
})
;(globalThis as Record<string, unknown>).useExclusionFilters ??= () => ({
  exclusions: { value: { labels: [] } },
})
;(globalThis as Record<string, unknown>).useBeadsPath = () => ({ beadsPath: beadsPathRef, hasStoredPath: vueRef(true) })

import { bdReady, logFrontend } from '~/utils/bd-api'
import { computeStatsFromIssues } from '~/utils/issue-helpers'

const { useDashboard } = await import('~/composables/useDashboard')

function makeIssue(id: string): Issue {
  return {
    id,
    title: `Issue ${id}`,
    description: '',
    status: 'open',
    priority: 'p2',
    type: 'task',
    labels: [],
    comments: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  }
}

describe('fetchStats — stale-path guard', () => {
  beforeEach(() => {
    beadsPathRef.value = '/proj/A'
    vi.mocked(bdReady).mockReset()
    vi.mocked(logFrontend).mockClear()
    vi.mocked(computeStatsFromIssues).mockClear()
  })

  // Race success-path: path changes after bdReady resolves — readyIssues must not be overwritten
  it('does not write readyIssues when path changes mid-flight', async () => {
    const { promise: ipcPromise, resolve: resolveReady } = makeDeferred<Issue[]>()
    vi.mocked(bdReady).mockReturnValue(ipcPromise)

    const { fetchStats, readyIssues } = useDashboard()

    const promise = fetchStats([makeIssue('a-1')])

    // Simulate project switch while bdReady is in-flight
    beadsPathRef.value = '/proj/B'

    resolveReady([makeIssue('a-ready-1'), makeIssue('a-ready-2')])
    await promise

    // readyIssues must not be set to stale A project data
    expect(readyIssues.value).toEqual([])
    expect(vi.mocked(logFrontend)).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('[fetchStats] bail'),
    )
  })

  // Inverse: fetchStats works normally when path does NOT change
  it('sets readyIssues normally when path is unchanged', async () => {
    const readyData = [makeIssue('a-ready-1')]
    vi.mocked(bdReady).mockResolvedValue(readyData)

    const { fetchStats, readyIssues } = useDashboard()
    await fetchStats([makeIssue('a-1')])

    expect(readyIssues.value).toEqual(readyData)
  })

  // Error-path bail: bdReady rejects after switch — error.value must stay null
  it('suppresses error and returns when bdReady rejects after path switch', async () => {
    let rejectReady!: (e: Error) => void
    vi.mocked(bdReady).mockReturnValue(
      new Promise((_, r) => { rejectReady = r }),
    )

    const { fetchStats, error } = useDashboard()
    const promise = fetchStats([])

    beadsPathRef.value = '/proj/B'
    rejectReady(new Error('network error'))
    await promise

    expect(error.value).toBeNull()
    expect(vi.mocked(logFrontend)).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('[fetchStats] suppressed stale-path error'),
    )
  })

  // stats.value must not be overwritten by a stale fetch — guard must precede mutation
  it('does not call computeStatsFromIssues when path changes mid-flight', async () => {
    const { promise: ipcPromise, resolve: resolveReady } = makeDeferred<Issue[]>()
    vi.mocked(bdReady).mockReturnValue(ipcPromise)

    const { fetchStats } = useDashboard()
    const promise = fetchStats([makeIssue('a-1'), makeIssue('a-2')])
    beadsPathRef.value = '/proj/B'

    resolveReady([])
    await promise

    // computeStatsFromIssues sits AFTER the path-guard. Stale fetch must bail before
    // computing — otherwise it would overwrite the new project's stats.
    expect(vi.mocked(computeStatsFromIssues)).not.toHaveBeenCalled()
  })

  // isLoading.value must not be reset in finally by a stale fetch while a new fetch is in-flight
  it('does not reset isLoading after stale bail in finally block', async () => {
    const { promise: promiseDeferredA, resolve: resolveA } = makeDeferred<Issue[]>()
    const { promise: promiseDeferredB, resolve: resolveB } = makeDeferred<Issue[]>()

    vi.mocked(bdReady)
      .mockReturnValueOnce(promiseDeferredA)
      .mockReturnValueOnce(promiseDeferredB)

    const { fetchStats, isLoading } = useDashboard()

    const promiseA = fetchStats([])
    expect(isLoading.value).toBe(true)

    beadsPathRef.value = '/proj/B'
    const promiseB = fetchStats([])
    expect(isLoading.value).toBe(true)

    // A bails after switch — finally must NOT reset isLoading because B is in-flight
    resolveA([])
    await promiseA
    expect(isLoading.value).toBe(true)

    // B resolves normally
    resolveB([])
    await promiseB
    expect(isLoading.value).toBe(false)
  })
})
