<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { BellIcon, TrashIcon, ExternalLinkIcon } from 'lucide-vue-next'
import { formatTimeAgo, useNow } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '~/components/ui/dropdown-menu'
import { Button } from '~/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { typeStyles, getNotificationIcon } from '~/utils/notification-styles'
import { useNotificationCenter } from '~/composables/useNotificationCenter'
import { useIssues } from '~/composables/useIssues'
import { useNotification } from '~/composables/useNotification'
import type { NotificationType } from '~/types/issue'

const { t } = useI18n()
const { history, unreadCount, clearAll, markAllRead } = useNotificationCenter()
// markAllRead is auto-triggered by the watch(isOpen) below; no manual button needed.
const { issues, selectIssue, fetchIssue } = useIssues()
const { warning: notifyWarning } = useNotification()

const isOpen = ref(false)

// One shared clock for all items — useTimeAgo per-item would leak timers on every render.
const now = useNow({ interval: 30_000 })

// When dropdown opens, mark all read
watch(isOpen, (open) => {
  if (open && unreadCount.value > 0) {
    markAllRead()
  }
})

const tooltipText = computed(() => {
  if (unreadCount.value > 0) {
    return t('notifications.center.tooltipUnread', { count: unreadCount.value })
  }
  return t('notifications.center.tooltip')
})

const badgeLabel = computed(() => {
  if (unreadCount.value > 99) return '99+'
  return String(unreadCount.value)
})

async function handleItemClick(issueId: string | undefined) {
  if (!issueId) return

  isOpen.value = false

  const found = issues.value.find(i => i.id === issueId)
  if (found) {
    selectIssue(found)
    await fetchIssue(issueId)
    return
  }

  notifyWarning(t('notifications.center.openIssueFailed'), issueId)
}

function formatTime(timestamp: number): string {
  return formatTimeAgo(new Date(timestamp), {}, now.value.getTime())
}
</script>

<template>
  <Tooltip>
    <DropdownMenu v-model:open="isOpen" :modal="false">
      <TooltipTrigger as-child>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="relative h-8 w-8"
            :aria-label="tooltipText"
          >
            <BellIcon class="w-4 h-4" aria-hidden="true" />
            <span
              v-if="unreadCount > 0"
              class="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold leading-4 text-center tabular-nums pointer-events-none"
            >
              {{ badgeLabel }}
            </span>
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent>{{ tooltipText }}</TooltipContent>

      <DropdownMenuContent
      class="w-96 p-0"
      align="end"
      :side-offset="8"
      :aria-label="t('notifications.center.title')"
    >
      <!-- Sticky header -->
      <div class="flex items-center justify-between px-3 py-2 border-b border-border sticky top-0 bg-popover z-10">
        <span class="text-sm font-semibold text-foreground">{{ t('notifications.center.title') }}</span>
        <Button
          v-if="history.length > 0"
          variant="ghost"
          size="icon"
          class="h-7 w-7"
          :aria-label="t('notifications.center.clearAll')"
          :title="t('notifications.center.clearAll')"
          @click.stop="clearAll"
        >
          <TrashIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
      </div>

      <!-- Notification list -->
      <div class="max-h-[460px] overflow-y-auto">
        <!-- Empty state -->
        <div
          v-if="history.length === 0"
          class="flex flex-col items-center justify-center py-10 text-center"
        >
          <BellIcon class="w-8 h-8 text-muted-foreground/40 mb-2" aria-hidden="true" />
          <p class="text-sm text-muted-foreground text-pretty">{{ t('notifications.center.empty') }}</p>
        </div>

        <!-- Notification items -->
        <template v-else>
          <div
            v-for="(item, index) in history"
            :key="item.id"
          >
            <DropdownMenuSeparator v-if="index > 0" class="my-0" />
            <button
              class="w-full text-left px-3 py-2.5 transition-colors hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
              :class="{ 'bg-accent/30': !item.read }"
              :disabled="!item.issueId"
              @click="handleItemClick(item.issueId)"
            >
              <div class="flex items-start gap-2.5">
                <!-- Type icon -->
                <component
                  :is="getNotificationIcon(item.type as NotificationType)"
                  class="w-4 h-4 shrink-0 mt-0.5"
                  :class="typeStyles[item.type as NotificationType].icon"
                  aria-hidden="true"
                />

                <!-- Content -->
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-foreground truncate text-pretty">{{ item.message }}</p>
                  <p
                    v-if="item.description"
                    class="text-xs text-muted-foreground mt-0.5 truncate"
                  >
                    {{ item.description }}
                  </p>
                  <div class="flex items-center gap-1 mt-1">
                    <span class="text-[10px] text-muted-foreground tabular-nums">
                      {{ formatTime(item.timestamp) }}
                    </span>
                    <ExternalLinkIcon
                      v-if="item.issueId"
                      class="w-2.5 h-2.5 text-muted-foreground/50"
                      aria-hidden="true"
                    />
                  </div>
                </div>

                <!-- Unread indicator -->
                <span
                  v-if="!item.read"
                  class="shrink-0 mt-1.5 w-2 h-2 rounded-full bg-primary"
                  aria-hidden="true"
                />
              </div>
            </button>
          </div>
        </template>
      </div>
      </DropdownMenuContent>
    </DropdownMenu>
  </Tooltip>
</template>
