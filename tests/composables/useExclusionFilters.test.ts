import { describe, it, expect, beforeEach } from 'vitest'
import { hashPath } from '../../app/utils/hash'

// Pure migration logic extracted for testing (mirrors app/composables/useExclusionFilters.ts)

const SYSTEM_LABELS = ['gt:slot']
const V1_FLAG = 'beads:system-labels-exclusion-migrated'
const V2_FLAG = 'beads:system-labels-migration-v2'

function perProjectMigrationKey(path: string): string {
  return `beads:proj:${hashPath(path)}:system-labels-migrated`
}

function upgradeV1FlagIfNeeded(store: Record<string, string>): void {
  if (store[V2_FLAG]) return
  delete store[V1_FLAG]
  store[V2_FLAG] = 'true'
}

interface ExclusionFilters {
  labels: string[]
}

/**
 * Simulate the per-project migration watcher logic for a single path.
 * Returns whether migration ran.
 */
function runMigration(
  path: string,
  store: Record<string, string>,
  exclusions: ExclusionFilters
): boolean {
  const key = perProjectMigrationKey(path)
  if (store[key]) return false
  for (const label of SYSTEM_LABELS) {
    if (!exclusions.labels.includes(label)) exclusions.labels.push(label)
  }
  store[key] = 'true'
  return true
}

// ────────────────────────────────────────────────────────────────────────────

describe('perProjectMigrationKey', () => {
  it('produces a stable key for a given path', () => {
    const key1 = perProjectMigrationKey('/Users/max/myproject')
    const key2 = perProjectMigrationKey('/Users/max/myproject')
    expect(key1).toBe(key2)
    expect(key1).toMatch(/^beads:proj:[0-9a-f]{8}:system-labels-migrated$/)
  })

  it('produces different keys for different paths', () => {
    const key1 = perProjectMigrationKey('/Users/max/project-a')
    const key2 = perProjectMigrationKey('/Users/max/project-b')
    expect(key1).not.toBe(key2)
  })
})

describe('upgradeV1FlagIfNeeded', () => {
  it('removes v1 flag and sets v2 flag on first call', () => {
    const store: Record<string, string> = { [V1_FLAG]: 'true' }
    upgradeV1FlagIfNeeded(store)
    expect(store[V1_FLAG]).toBeUndefined()
    expect(store[V2_FLAG]).toBe('true')
  })

  it('is idempotent — calling twice leaves v2="true" and does not re-add v1', () => {
    const store: Record<string, string> = { [V1_FLAG]: 'true' }
    upgradeV1FlagIfNeeded(store)
    upgradeV1FlagIfNeeded(store)
    expect(store[V1_FLAG]).toBeUndefined()
    expect(store[V2_FLAG]).toBe('true')
  })

  it('does nothing when v2 flag already present', () => {
    const store: Record<string, string> = {
      [V1_FLAG]: 'true',
      [V2_FLAG]: 'true',
    }
    upgradeV1FlagIfNeeded(store)
    // v1 should NOT be removed because the guard exits early
    expect(store[V1_FLAG]).toBe('true')
    expect(store[V2_FLAG]).toBe('true')
  })
})

describe('per-project migration — runMigration', () => {
  const PATH_A = '/Users/max/project-a'
  const PATH_B = '/Users/max/project-b'
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
  })

  it('test 1 — fresh install: adds gt:slot and sets per-project flag', () => {
    const exclusions: ExclusionFilters = { labels: [] }
    const ran = runMigration(PATH_A, store, exclusions)
    expect(ran).toBe(true)
    expect(exclusions.labels).toContain('gt:slot')
    expect(store[perProjectMigrationKey(PATH_A)]).toBe('true')
  })

  it('test 2 — no duplication: gt:slot already present is not added again', () => {
    const exclusions: ExclusionFilters = { labels: ['gt:slot'] }
    runMigration(PATH_A, store, exclusions)
    expect(exclusions.labels.filter(l => l === 'gt:slot').length).toBe(1)
  })

  it('test 5 — user choice respected: per-project flag set + labels=[] → gt:slot NOT re-added', () => {
    // Simulate: migration already ran, user later removed gt:slot
    store[perProjectMigrationKey(PATH_A)] = 'true'
    const exclusions: ExclusionFilters = { labels: [] }
    const ran = runMigration(PATH_A, store, exclusions)
    expect(ran).toBe(false)
    expect(exclusions.labels).not.toContain('gt:slot')
  })

  it('test 6 — project switch: new project without per-project flag triggers migration', () => {
    // PATH_A already migrated
    store[perProjectMigrationKey(PATH_A)] = 'true'
    const exclusionsA: ExclusionFilters = { labels: ['gt:slot'] }
    const exclusionsB: ExclusionFilters = { labels: [] }

    // Switch to PATH_B — migration runs
    const ran = runMigration(PATH_B, store, exclusionsB)
    expect(ran).toBe(true)
    expect(exclusionsB.labels).toContain('gt:slot')
    expect(store[perProjectMigrationKey(PATH_B)]).toBe('true')
    // PATH_A flag unaffected
    expect(store[perProjectMigrationKey(PATH_A)]).toBe('true')
    // PATH_A exclusions unaffected
    expect(exclusionsA.labels).toContain('gt:slot')
  })

  it('test 7 — switch back: returning to project where user cleared gt:slot keeps it cleared', () => {
    // User previously ran migration on PATH_A, then manually removed gt:slot
    store[perProjectMigrationKey(PATH_A)] = 'true'
    const exclusions: ExclusionFilters = { labels: [] }

    // Simulate returning to PATH_A
    const ran = runMigration(PATH_A, store, exclusions)
    expect(ran).toBe(false)
    expect(exclusions.labels).not.toContain('gt:slot')
  })
})

describe('v1 to v2 upgrade combined with per-project migration', () => {
  it('test 3 — v1 upgrade: v1 flag removed, v2 set, per-project migration then runs', () => {
    const store: Record<string, string> = { [V1_FLAG]: 'true' }
    const path = '/Users/max/project-a'
    const exclusions: ExclusionFilters = { labels: [] }

    upgradeV1FlagIfNeeded(store)
    expect(store[V1_FLAG]).toBeUndefined()
    expect(store[V2_FLAG]).toBe('true')

    // Per-project migration now runs because no per-project flag exists
    runMigration(path, store, exclusions)
    expect(exclusions.labels).toContain('gt:slot')
    expect(store[perProjectMigrationKey(path)]).toBe('true')
  })
})
