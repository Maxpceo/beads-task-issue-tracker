import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hashPath } from '~/utils/hash'

// Integration test: imports the real useFilters composable against a fresh
// in-memory localStorage per test. Each test uses vi.resetModules() so the
// module-level singleton state in useProjectStorage is reset, which simulates
// "app reload" — the key scenario this bead fixes (filters must survive
// refresh/project switch instead of being force-reset to workflow defaults).

const PROJECT_A = '/tmp/project-a'
const PROJECT_B = '/tmp/project-b'
const WORKFLOW_STATUSES = ['open', 'in_progress', 'deferred', 'pinned', 'hooked']

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

function filtersKey(path: string): string {
  return `beads:proj:${hashPath(path)}:filters`
}

function createMemoryStorage(): Storage {
  let data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => { data = new Map() },
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)) },
    removeItem: (key: string) => { data.delete(key) },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
  }
}

async function importFresh() {
  vi.resetModules()
  const filtersMod = await import('~/composables/useFilters')
  const pathMod = await import('~/composables/useBeadsPath')
  return { ...filtersMod, ...pathMod }
}

describe('useFilters (integration)', () => {
  beforeEach(() => {
    const storage = createMemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage, writable: true, configurable: true,
    })
    localStorage.setItem('beads:path', JSON.stringify(PROJECT_A))
  })

  it('fresh install: status defaults to workflow view, other fields empty', async () => {
    const { useFilters } = await importFresh()
    const { filters } = useFilters()

    expect(filters.value.status).toEqual(WORKFLOW_STATUSES)
    expect(filters.value.type).toEqual([])
    expect(filters.value.priority).toEqual([])
    expect(filters.value.assignee).toEqual([])
    expect(filters.value.labels).toEqual([])
    expect(filters.value.search).toBe('')
  })

  it('user-cleared filters persist across reload (the bug this bead fixes)', async () => {
    // First session: user clears all filters
    const session1 = await importFresh()
    const { clearFilters } = session1.useFilters()
    clearFilters()
    await flushPromises()

    const stored = localStorage.getItem(filtersKey(PROJECT_A))
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored!)
    expect(parsed.status).toEqual([])

    // Second session: simulate app reload via vi.resetModules + re-import
    const session2 = await importFresh()
    const { filters } = session2.useFilters()

    expect(filters.value.status).toEqual([])
    expect(filters.value.type).toEqual([])
  })

  it('project switch round-trip: cleared filters in A survive A → B → A', async () => {
    const { useFilters, useBeadsPath } = await importFresh()
    const { filters, clearFilters } = useFilters()
    const { setPath } = useBeadsPath()

    clearFilters()
    await flushPromises()
    expect(filters.value.status).toEqual([])

    setPath(PROJECT_B)
    await flushPromises()
    expect(filters.value.status).toEqual(WORKFLOW_STATUSES)

    setPath(PROJECT_A)
    await flushPromises()
    expect(filters.value.status).toEqual([])
  })

  it('search / labels / assignee persist across reload (no longer force-cleared)', async () => {
    const session1 = await importFresh()
    const { filters, setSearch, toggleLabelFilter, toggleAssignee } = session1.useFilters()

    setSearch('foo')
    toggleLabelFilter('bug')
    toggleAssignee('alice')
    await flushPromises()

    expect(filters.value.search).toBe('foo')
    expect(filters.value.labels).toEqual(['bug'])
    expect(filters.value.assignee).toEqual(['alice'])

    const session2 = await importFresh()
    const { filters: reloadedFilters } = session2.useFilters()

    expect(reloadedFilters.value.search).toBe('foo')
    expect(reloadedFilters.value.labels).toEqual(['bug'])
    expect(reloadedFilters.value.assignee).toEqual(['alice'])
  })

  it('hasActiveFilters: true for default workflow, false after clearFilters', async () => {
    const { useFilters } = await importFresh()
    const { hasActiveFilters, clearFilters } = useFilters()

    expect(hasActiveFilters.value).toBe(true)

    clearFilters()
    await flushPromises()

    expect(hasActiveFilters.value).toBe(false)
  })
})
