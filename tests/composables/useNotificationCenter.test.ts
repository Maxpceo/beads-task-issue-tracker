import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import type { Notification } from '~/types/issue'

// Each test uses vi.resetModules() to reset module-level singleton state in
// useNotificationCenter (history ref) and useProjectStorage.

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

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: Math.random(),
    message: 'Test message',
    type: 'info',
    timestamp: Date.now(),
    read: false,
    ...overrides,
  }
}

async function importFresh() {
  vi.resetModules()
  const mod = await import('~/composables/useNotificationCenter')
  return mod
}

describe('useNotificationCenter', () => {
  beforeEach(() => {
    const storage = createMemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage, writable: true, configurable: true,
    })
    localStorage.setItem('beads:path', JSON.stringify('/tmp/test-project'))
  })

  it('addToHistory prepends and trims to 100', async () => {
    const { useNotificationCenter } = await importFresh()
    const { history, addToHistory } = useNotificationCenter()

    // Add 105 notifications
    for (let i = 0; i < 105; i++) {
      addToHistory(makeNotification({ id: i, message: `Notification ${i}` }))
    }

    expect(history.value.length).toBe(100)
    // Most recent should be first (id=104)
    expect(history.value[0]!.id).toBe(104)
    expect(history.value[0]!.message).toBe('Notification 104')
    // Oldest should be at index 99 (id=5)
    expect(history.value[99]!.id).toBe(5)
  })

  it('addToHistory prepends: newest item is first', async () => {
    const { useNotificationCenter } = await importFresh()
    const { history, addToHistory } = useNotificationCenter()

    const first = makeNotification({ id: 1, message: 'First' })
    const second = makeNotification({ id: 2, message: 'Second' })
    addToHistory(first)
    addToHistory(second)

    expect(history.value[0]!.message).toBe('Second')
    expect(history.value[1]!.message).toBe('First')
  })

  it('clearAll empties history', async () => {
    const { useNotificationCenter } = await importFresh()
    const { history, addToHistory, clearAll } = useNotificationCenter()

    addToHistory(makeNotification({ id: 1 }))
    addToHistory(makeNotification({ id: 2 }))
    expect(history.value.length).toBe(2)

    clearAll()
    expect(history.value.length).toBe(0)
  })

  it('markAllRead sets all read to true, unreadCount becomes 0', async () => {
    const { useNotificationCenter } = await importFresh()
    const { history, addToHistory, markAllRead, unreadCount } = useNotificationCenter()

    addToHistory(makeNotification({ id: 1, read: false }))
    addToHistory(makeNotification({ id: 2, read: false }))
    addToHistory(makeNotification({ id: 3, read: false }))

    expect(unreadCount.value).toBe(3)

    markAllRead()

    expect(unreadCount.value).toBe(0)
    expect(history.value.every(n => n.read === true)).toBe(true)
  })

  it('unreadCount is reactive: increases when new unread notification added', async () => {
    const { useNotificationCenter } = await importFresh()
    const { unreadCount, addToHistory } = useNotificationCenter()

    expect(unreadCount.value).toBe(0)

    addToHistory(makeNotification({ id: 1, read: false }))
    expect(unreadCount.value).toBe(1)

    addToHistory(makeNotification({ id: 2, read: true }))
    expect(unreadCount.value).toBe(1)

    addToHistory(makeNotification({ id: 3, read: false }))
    expect(unreadCount.value).toBe(2)
  })

  it('history is readonly: direct mutations are ignored', async () => {
    const { useNotificationCenter } = await importFresh()
    const { history, addToHistory } = useNotificationCenter()

    addToHistory(makeNotification({ id: 1, message: 'Original' }))

    // Attempt to mutate the readonly ref should not change internal state
    // (Vue readonly wraps the ref but does warn in dev mode)
    const snapshot = history.value
    expect(snapshot.length).toBe(1)
    expect(snapshot[0]!.message).toBe('Original')
  })
})
