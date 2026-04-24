import { computed, readonly } from 'vue'
import type { Notification } from '~/types/issue'
import { useProjectStorage } from '~/composables/useProjectStorage'

const MAX_HISTORY = 100

// Module-scope singleton — persisted via useProjectStorage
const history = useProjectStorage<Notification[]>('notificationHistory', [])

const unreadCount = computed(() => history.value.filter(n => !n.read).length)

function addToHistory(n: Notification) {
  // Prepend and trim to MAX_HISTORY
  history.value = [n, ...history.value].slice(0, MAX_HISTORY)
}

function clearAll() {
  history.value = []
}

function markAllRead() {
  history.value = history.value.map(n => ({ ...n, read: true }))
}

export function useNotificationCenter() {
  return {
    history: readonly(history),
    unreadCount,
    addToHistory,
    clearAll,
    markAllRead,
  }
}
