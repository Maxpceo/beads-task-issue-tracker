<script setup lang="ts">
import { XIcon } from 'lucide-vue-next'
import { typeStyles, getNotificationIcon } from '~/utils/notification-styles'

const { notifications, dismiss } = useNotification()
</script>

<template>
  <Teleport to="body">
    <div class="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      <TransitionGroup name="notification">
        <div
          v-for="notification in notifications"
          :key="notification.id"
          class="pointer-events-auto rounded-lg shadow-xl p-3 min-w-[280px] max-w-[380px] flex items-start gap-3 border-l-4"
          :class="[typeStyles[notification.type].bg, typeStyles[notification.type].border]"
        >
          <component
            :is="getNotificationIcon(notification.type)"
            class="w-5 h-5 shrink-0 mt-0.5"
            :class="typeStyles[notification.type].icon"
          />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-foreground">{{ notification.message }}</p>
            <p v-if="notification.description" class="text-xs text-muted-foreground mt-0.5 truncate">
              {{ notification.description }}
            </p>
          </div>
          <button
            class="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            @click="dismiss(notification.id)"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.notification-enter-active,
.notification-leave-active {
  transition: all 0.3s ease;
}

.notification-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.notification-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
</style>
