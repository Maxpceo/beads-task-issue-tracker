<script setup lang="ts">
const props = defineProps<{
  open: number
  closed: number
}>()

const { t } = useI18n()
const { currentTheme } = useTheme()
const isNeon = computed(() => currentTheme.value.id === 'neon')

const total = computed(() => props.open + props.closed)
const openPercent = computed(() =>
  total.value > 0 ? (props.open / total.value) * 100 : 0
)
const closedPercent = computed(() =>
  total.value > 0 ? (props.closed / total.value) * 100 : 0
)

const neonBarStyle = (rgb: string, percent: number) => {
  if (!isNeon.value || percent === 0) return {}
  return {
    backgroundColor: `rgb(${rgb})`,
    boxShadow: `0 0 8px rgba(${rgb}, 0.4), inset 0 0 6px rgba(${rgb}, 0.2)`,
  }
}
</script>

<template>
  <div class="space-y-3">
    <h4 class="text-sm font-medium text-muted-foreground">{{ t('dashboard.charts.statusTitle') }}</h4>

    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <span class="w-16 text-xs" :class="isNeon ? 'text-[var(--color-status-open)]' : 'text-muted-foreground'">{{ t('dashboard.charts.open') }}</span>
        <div class="flex-1 h-2 rounded overflow-hidden" :class="isNeon ? 'bg-white/5' : 'bg-secondary'">
          <div
            class="h-full w-full bg-status-open origin-left transition-transform"
            :style="{ transform: `scaleX(${openPercent / 100})`, ...neonBarStyle('0, 212, 255', openPercent) }"
          />
        </div>
        <span class="w-8 text-xs text-right" :class="isNeon ? 'text-[var(--color-status-open)]' : ''">{{ open }}</span>
      </div>

      <div class="flex items-center gap-2">
        <span class="w-16 text-xs" :class="isNeon ? 'text-[var(--color-status-closed)]' : 'text-muted-foreground'">{{ t('dashboard.charts.closed') }}</span>
        <div class="flex-1 h-2 rounded overflow-hidden" :class="isNeon ? 'bg-white/5' : 'bg-secondary'">
          <div
            class="h-full w-full bg-status-closed origin-left transition-transform"
            :style="{ transform: `scaleX(${closedPercent / 100})`, ...neonBarStyle('136, 146, 160', closedPercent) }"
          />
        </div>
        <span class="w-8 text-xs text-right" :class="isNeon ? 'text-[var(--color-status-closed)]' : ''">{{ closed }}</span>
      </div>
    </div>
  </div>
</template>
