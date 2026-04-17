import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hashPath } from '~/utils/hash'

// Integration test: imports the real useExclusionFilters composable and
// exercises the per-project `gt:slot` migration + v1→v2 upgrade through a
// fresh in-memory localStorage per test. Each test uses vi.resetModules()
// so the module-level block in useExclusionFilters.ts re-runs (that block
// sets up the watch(beadsPath, ..., { immediate: true }) that drives the
// migration).

const PROJECT_A = '/tmp/project-a'
const PROJECT_B = '/tmp/project-b'
const V1_FLAG = 'beads:system-labels-exclusion-migrated'
const V2_FLAG = 'beads:system-labels-migration-v2'

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

function perProjectMigrationKey(path: string): string {
  return `beads:proj:${hashPath(path)}:system-labels-migrated`
}

function exclusionsKey(path: string): string {
  return `beads:proj:${hashPath(path)}:exclusionFilters`
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
  const composable = await import('~/composables/useExclusionFilters')
  const pathMod = await import('~/composables/useBeadsPath')
  return { ...composable, ...pathMod }
}

describe('useExclusionFilters (integration)', () => {
  beforeEach(() => {
    const storage = createMemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage, writable: true, configurable: true,
    })
    localStorage.setItem('beads:path', JSON.stringify(PROJECT_A))
  })

  it('fresh install: module load triggers migration — gt:slot in memory, per-project flag set', async () => {
    const { useExclusionFilters } = await importFresh()
    await flushPromises()

    // Migration watcher fires immediately — per-project flag must be set in localStorage
    expect(localStorage.getItem(perProjectMigrationKey(PROJECT_A))).toBe('true')
    expect(localStorage.getItem(V2_FLAG)).toBe('true')

    // gt:slot is present in the in-memory ref (useProjectStorage lazy-writes;
    // the value lives in the reactive ref even before any user interaction persists it)
    const { exclusions } = useExclusionFilters()
    expect(exclusions.value.labels).toContain('gt:slot')
  })

  it('v1 → v2 upgrade on module load: v1 flag removed, v2 flag set', async () => {
    localStorage.setItem(V1_FLAG, 'true')

    await importFresh()
    await flushPromises()

    expect(localStorage.getItem(V1_FLAG)).toBeNull()
    expect(localStorage.getItem(V2_FLAG)).toBe('true')
  })

  it('user choice respected: per-project flag already set → gt:slot is NOT re-added', async () => {
    localStorage.setItem(perProjectMigrationKey(PROJECT_A), 'true')
    localStorage.setItem(exclusionsKey(PROJECT_A), JSON.stringify({
      status: [], priority: [], type: [], labels: [], assignee: [],
    }))

    const { useExclusionFilters } = await importFresh()
    await flushPromises()

    const { exclusions } = useExclusionFilters()
    expect(exclusions.value.labels).not.toContain('gt:slot')
  })

  it('no duplication: gt:slot already in labels is not added twice', async () => {
    localStorage.setItem(exclusionsKey(PROJECT_A), JSON.stringify({
      status: [], priority: [], type: [], labels: ['gt:slot'], assignee: [],
    }))

    const { useExclusionFilters } = await importFresh()
    await flushPromises()

    const { exclusions } = useExclusionFilters()
    expect(exclusions.value.labels.filter(l => l === 'gt:slot').length).toBe(1)
  })

  it('project switch: setPath to new project triggers migration for it', async () => {
    const { useExclusionFilters, useBeadsPath } = await importFresh()
    await flushPromises()

    expect(localStorage.getItem(perProjectMigrationKey(PROJECT_A))).toBe('true')

    const { setPath } = useBeadsPath()
    setPath(PROJECT_B)
    await flushPromises()

    expect(localStorage.getItem(perProjectMigrationKey(PROJECT_B))).toBe('true')

    const storedB = localStorage.getItem(exclusionsKey(PROJECT_B))
    expect(storedB).not.toBeNull()
    const parsedB = JSON.parse(storedB!) as { labels: string[] }
    expect(parsedB.labels).toContain('gt:slot')

    const { exclusions } = useExclusionFilters()
    expect(exclusions.value.labels).toContain('gt:slot')
  })

  it('switch back after user cleared gt:slot: flag still set, migration skipped', async () => {
    // Seed: PROJECT_A migrated, user then removed gt:slot
    localStorage.setItem(perProjectMigrationKey(PROJECT_A), 'true')
    localStorage.setItem(exclusionsKey(PROJECT_A), JSON.stringify({
      status: [], priority: [], type: [], labels: [], assignee: [],
    }))

    const { useExclusionFilters, useBeadsPath } = await importFresh()
    await flushPromises()

    const { setPath } = useBeadsPath()
    setPath(PROJECT_B)
    await flushPromises()
    setPath(PROJECT_A)
    await flushPromises()

    const { exclusions } = useExclusionFilters()
    expect(exclusions.value.labels).not.toContain('gt:slot')
  })

  it('activeCount/hasActiveExclusions reflect real exclusions state', async () => {
    const { useExclusionFilters } = await importFresh()
    await flushPromises()

    const { exclusions, activeCount, hasActiveExclusions, toggleLabel, clearAll } = useExclusionFilters()

    // After fresh-install migration labels has `gt:slot`
    expect(exclusions.value.labels).toContain('gt:slot')
    expect(activeCount.value).toBe(1)
    expect(hasActiveExclusions.value).toBe(true)

    toggleLabel('foo')
    expect(activeCount.value).toBe(2)
    expect(exclusions.value.labels).toContain('foo')

    clearAll()
    expect(activeCount.value).toBe(0)
    expect(hasActiveExclusions.value).toBe(false)
  })
})
