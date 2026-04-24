import { InfoIcon, CheckCircleIcon, AlertCircleIcon, AlertTriangleIcon } from 'lucide-vue-next'
import type { NotificationType } from '~/types/issue'

export interface NotificationTypeStyle {
  bg: string
  border: string
  icon: string
}

export const typeStyles: Record<NotificationType, NotificationTypeStyle> = {
  info: {
    bg: 'bg-sky-50 dark:bg-[#0a1929]',
    border: 'border-sky-500',
    icon: 'text-sky-600 dark:text-sky-400',
  },
  success: {
    bg: 'bg-emerald-50 dark:bg-[#071a12]',
    border: 'border-emerald-500',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  error: {
    bg: 'bg-red-50 dark:bg-[#1f0a0a]',
    border: 'border-red-500',
    icon: 'text-red-600 dark:text-red-400',
  },
  warning: {
    bg: 'bg-amber-50 dark:bg-[#1a1408]',
    border: 'border-amber-500',
    icon: 'text-amber-600 dark:text-amber-400',
  },
}

export function getNotificationIcon(type: NotificationType) {
  switch (type) {
    case 'success': return CheckCircleIcon
    case 'error': return AlertCircleIcon
    case 'warning': return AlertTriangleIcon
    default: return InfoIcon
  }
}
