import { ref, readonly } from 'vue'
import type { Notification, NotificationType } from '~/types/issue'
import { useNotificationCenter } from '~/composables/useNotificationCenter'

export type { NotificationType }

export interface NotificationOptions {
  issueId?: string
  durationMs?: number
}

const notifications = ref<Notification[]>([])
let nextId = 0

export function useNotification() {
  const addNotification = (
    message: string,
    description?: string,
    type: NotificationType = 'info',
    options?: NotificationOptions,
  ) => {
    const id = nextId++
    const durationMs = options?.durationMs ?? 5000
    const n: Notification = {
      id,
      message,
      description,
      type,
      issueId: options?.issueId,
      timestamp: Date.now(),
      read: false,
    }
    notifications.value.push(n)

    const { addToHistory } = useNotificationCenter()
    addToHistory(n)

    setTimeout(() => {
      notifications.value = notifications.value.filter(item => item.id !== id)
    }, durationMs)
  }

  const notify = (message: string, description?: string, options?: NotificationOptions) =>
    addNotification(message, description, 'info', options)
  const success = (message: string, description?: string, options?: NotificationOptions) =>
    addNotification(message, description, 'success', options)
  const error = (message: string, description?: string, options?: NotificationOptions) =>
    addNotification(message, description, 'error', options)
  const warning = (message: string, description?: string, options?: NotificationOptions) =>
    addNotification(message, description, 'warning', options)

  const dismiss = (id: number) => {
    notifications.value = notifications.value.filter(n => n.id !== id)
  }

  return {
    notifications: readonly(notifications),
    notify,
    success,
    error,
    warning,
    dismiss,
  }
}
