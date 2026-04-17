import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { hashPath } from '~/utils/hash'

// Vitest cannot patch import.meta.client per-module (ES modules have independent meta).
// We mock useProjectStorage to re-implement it without the import.meta.client guard,
// using real localStorage so integration behaviour is preserved.
vi.mock('~/composables/useProjectStorage', async () => {
  const { ref, watch, triggerRef } = await import('vue')
  const { hashPath: hp } = await import('~/utils/hash')

  const settingsRegistry = new Map<string, { setting: string; defaultValue: unknown; valueRef: ReturnType<typeof ref> }>()
  let currentProjectHash: string | null = null

  function getBeadsPath(): string {
    const stored = localStorage.getItem('beads:path')
    if (stored) { try { return JSON.parse(stored) || '.' } catch { return '.' } }
    return '.'
  }
  function getFullKey(setting: string, hash: string) { return `beads:proj:${hash}:${setting}` }
  function loadValue<T>(setting: string, defaultValue: T): T {
    const hash = hp(getBeadsPath())
    const raw = localStorage.getItem(getFullKey(setting, hash))
    if (raw) { try { return JSON.parse(raw) } catch { return defaultValue } }
    return defaultValue
  }

  const saveProjectValue = <T>(setting: string, value: T): void => {
    const hash = hp(getBeadsPath())
    localStorage.setItem(getFullKey(setting, hash), JSON.stringify(value))
  }

  const reloadProjectStorage = (): void => {
    const newHash = hp(getBeadsPath())
    if (currentProjectHash === newHash) return
    currentProjectHash = newHash
    for (const [, meta] of settingsRegistry) {
      meta.valueRef.value = loadValue(meta.setting, meta.defaultValue)
      triggerRef(meta.valueRef)
    }
  }

  const clearProjectStorageCache = (): void => {
    currentProjectHash = null
    settingsRegistry.clear()
  }

  const useProjectStorage = <T>(setting: string, defaultValue: T): ReturnType<typeof ref<T>> => {
    if (currentProjectHash === null) currentProjectHash = hp(getBeadsPath())
    if (settingsRegistry.has(setting)) return settingsRegistry.get(setting)!.valueRef as ReturnType<typeof ref<T>>
    const valueRef = ref<T>(loadValue(setting, defaultValue))
    settingsRegistry.set(setting, { setting, defaultValue, valueRef })
    watch(valueRef, (v) => { saveProjectValue(setting, v) }, { deep: true })
    return valueRef as ReturnType<typeof ref<T>>
  }

  return { useProjectStorage, saveProjectValue, reloadProjectStorage, clearProjectStorageCache }
})

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

const PROJECT_PATH = '/tmp/test-project'
const PROJECT_HASH = hashPath(PROJECT_PATH)
const STORAGE_KEY = `beads:proj:${PROJECT_HASH}:status-colors`

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

// Import once — vi.mock is hoisted and stable across the suite.
// We reset per-test state via clearProjectStorageCache + resetting the module-level store.
import { useStatusColorOverrides } from '~/composables/useStatusColorOverrides'
import { clearProjectStorageCache, reloadProjectStorage } from '~/composables/useProjectStorage'

describe('useStatusColorOverrides (integration)', () => {
  beforeEach(() => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', { ...(globalThis as unknown as { window?: object }).window, localStorage: storage })
    localStorage.setItem('beads:path', JSON.stringify(PROJECT_PATH))
  })

  it('setOverride/getOverride/removeOverride round-trip via real composable', async () => {
    const { useStatusColorOverrides } = await importFresh()
    const { getOverride, setOverride, removeOverride } = useStatusColorOverrides()

    expect(getOverride('open')).toBeUndefined()

    setOverride('open', { from: '#ff0000' })
    expect(getOverride('open')).toEqual({ from: '#ff0000' })

    setOverride('inreview', { from: '#ff0000', to: '#00ff00' })
    expect(getOverride('inreview')).toEqual({ from: '#ff0000', to: '#00ff00' })

    removeOverride('open')
    expect(getOverride('open')).toBeUndefined()
    expect(getOverride('inreview')).toEqual({ from: '#ff0000', to: '#00ff00' })
  })

  it('persists to localStorage under beads:proj:<hash>:status-colors', async () => {
    const { useStatusColorOverrides } = await importFresh()
    const { setOverride } = useStatusColorOverrides()

    setOverride('open', { from: '#123456' })
    await flushPromises()

    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({ open: { from: '#123456' } })
  })

  it('uses a project-scoped key (different hash per beadsPath)', async () => {
    const otherPath = '/tmp/another-project'
    const otherHash = hashPath(otherPath)
    expect(otherHash).not.toBe(PROJECT_HASH)

    const { useStatusColorOverrides } = await importFresh()
    const { setOverride } = useStatusColorOverrides()

    setOverride('open', { from: '#abcdef' })
    await flushPromises()

    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
    expect(localStorage.getItem(`beads:proj:${otherHash}:status-colors`)).toBeNull()
  })

  it('switches stored values when beadsPath changes and reloadProjectStorage is called', async () => {
    const otherPath = '/tmp/another-project'
    const otherHash = hashPath(otherPath)
    const otherKey = `beads:proj:${otherHash}:status-colors`
    localStorage.setItem(otherKey, JSON.stringify({ closed: { from: '#00ff00' } }))

    const { useStatusColorOverrides, reloadProjectStorage } = await importFresh()
    const { getOverride, setOverride } = useStatusColorOverrides()

    setOverride('open', { from: '#ff0000' })
    await flushPromises()
    expect(getOverride('open')).toEqual({ from: '#ff0000' })
    expect(getOverride('closed')).toBeUndefined()

    localStorage.setItem('beads:path', JSON.stringify(otherPath))
    reloadProjectStorage()
    await nextTick()

    expect(getOverride('open')).toBeUndefined()
    expect(getOverride('closed')).toEqual({ from: '#00ff00' })
  })

  it('restores existing overrides from localStorage on first use (persistence across reload)', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ open: { from: '#111111' }, closed: { from: '#222222', to: '#333333' } })
    )

    const { useStatusColorOverrides } = await importFresh()
    const { getOverride } = useStatusColorOverrides()

    expect(getOverride('open')).toEqual({ from: '#111111' })
    expect(getOverride('closed')).toEqual({ from: '#222222', to: '#333333' })
  })
})
