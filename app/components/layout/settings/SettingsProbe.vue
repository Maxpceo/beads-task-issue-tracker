<script setup lang="ts">
import { Label } from '~/components/ui/label'
import { Button } from '~/components/ui/button'
import { checkExternalHealth } from '~/utils/bd-api'

const { t } = useI18n()

const probeEnabled = useLocalStorage('beads:probeEnabled', false)
const dataSourceUrl = useLocalStorage('beads:dataSourceUrl', 'http://localhost:9100')
const isTesting = ref(false)
const healthResult = ref<boolean | null>(null)

async function testConnection() {
  isTesting.value = true
  healthResult.value = null
  try {
    healthResult.value = await checkExternalHealth(dataSourceUrl.value)
  } catch {
    healthResult.value = false
  } finally {
    isTesting.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <Label>{{ t('settings.probe.title') }}</Label>
      <button
        type="button"
        role="switch"
        class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        :class="probeEnabled ? 'bg-primary' : 'bg-muted-foreground/30'"
        :aria-label="t('settings.probe.toggleAria')"
        :aria-checked="probeEnabled"
        @click="probeEnabled = !probeEnabled; healthResult = null"
      >
        <span
          class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform"
          :class="probeEnabled ? 'translate-x-4.5' : 'translate-x-0.5'"
        />
      </button>
    </div>
    <p class="text-xs text-muted-foreground text-pretty">
      {{ t('settings.probe.description') }}
    </p>

    <div v-if="probeEnabled" class="space-y-2">
      <div class="flex gap-2">
        <label for="probe-url" class="sr-only">{{ t('settings.probe.urlLabel') }}</label>
        <input
          id="probe-url"
          v-model="dataSourceUrl"
          type="text"
          placeholder="http://localhost:9100"
          class="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button size="sm" variant="outline" :disabled="isTesting" @click="testConnection">
          <svg v-if="isTesting" class="animate-spin h-3 w-3 mr-1" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          {{ t('settings.probe.test') }}
        </Button>
      </div>

      <div v-if="healthResult !== null" class="flex items-center gap-1.5 text-xs" role="status" aria-live="polite">
        <svg v-if="healthResult" class="w-3.5 h-3.5 text-green-600 dark:text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <svg v-else class="w-3.5 h-3.5 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span :class="healthResult ? 'text-green-600 dark:text-green-400' : 'text-destructive'">
          {{ healthResult ? t('settings.probe.connected') : t('settings.probe.disconnected') }}
        </span>
      </div>
    </div>
  </div>
</template>
