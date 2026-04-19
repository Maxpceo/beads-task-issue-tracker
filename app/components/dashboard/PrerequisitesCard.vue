<script setup lang="ts">
import LinkifiedText from '~/components/ui/linkified-text/LinkifiedText.vue'

const { t } = useI18n()

const prerequisitesContent = computed(() => t('dashboard.prerequisites.content'))
</script>

<template>
  <div class="flex flex-col items-center justify-center h-full p-8 my-4">
    <div class="max-w-2xl w-full bg-card border border-border rounded-lg p-6 space-y-6">
      <!-- Header with icon -->
      <div class="flex items-center gap-3 pb-4 border-b border-border">
        <div class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
          <svg class="w-5 h-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        </div>
        <div>
          <h2 class="text-lg font-semibold">{{ t('dashboard.prerequisites.welcomeTitle') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('dashboard.prerequisites.welcomeSubtitle') }}</p>
        </div>
      </div>

      <!-- Markdown content -->
      <div class="markdown-base compact">
        <LinkifiedText :text="prerequisitesContent" />
      </div>

    </div>
  </div>
</template>
