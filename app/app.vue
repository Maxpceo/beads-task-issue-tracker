<script setup lang="ts">
  import { TooltipProvider } from '~/components/ui/tooltip'
  import { NotificationToast } from '~/components/ui/notification-toast'

  const { isDark } = useTheme()
  const { showUpdateDialog, showAboutDialog, showSettingsDialog, initializeMenu } = useAppMenu()

  useHead({
    title: 'Beads Task-Issue Tracker',
    meta: [
      { name: 'description', content: 'Beads Task / Issue Tracking Manager' },
      { name: 'theme-color', content: () => isDark.value ? '#1e1e1e' : '#ffffff' },
    ],
    htmlAttrs: {
      lang: 'en',
      class: () => isDark.value ? 'dark' : '',
    },
  })

  onMounted(() => {
    initializeMenu()
    if (import.meta.dev) {
      // Dev-only hook for Tauri MCP visual QA — lets headless tests open Settings.
      ;(window as unknown as { __openSettings?: () => void }).__openSettings = () => {
        showSettingsDialog.value = true
      }
    }
  })
</script>

<template>
  <TooltipProvider>
    <NuxtPage />
    <LayoutUpdateDialog v-model:open="showUpdateDialog" />
    <LayoutAboutDialog v-model:open="showAboutDialog" />
    <LayoutSettingsDialog v-model:open="showSettingsDialog" />
    <NotificationToast />
  </TooltipProvider>
</template>
