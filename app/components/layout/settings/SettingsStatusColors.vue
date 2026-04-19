<script setup lang="ts">
import { Label } from '~/components/ui/label'
import { Button } from '~/components/ui/button'
import type { IssueStatus } from '~/types/issue'
import { useStatuses } from '~/composables/useStatuses'
import { useStatusColorOverrides } from '~/composables/useStatusColorOverrides'
import StatusBadge from '~/components/issues/StatusBadge.vue'

const { t } = useI18n()
const { statuses } = useStatuses()
const { getOverride, setOverride, removeOverride } = useStatusColorOverrides()

interface ColorPickerState {
  useGradient: boolean
  from: string
  to: string
}

const DEFAULT_FROM: Record<string, string> = {
  active: '#3b82f6',
  wip: '#8b5cf6',
  done: '#22c55e',
  frozen: '#6b7280',
}

function getDefaultFrom(category: string): string {
  return DEFAULT_FROM[category] ?? '#3b82f6'
}

const localColors = ref<Record<string, ColorPickerState>>({})

watch(
  statuses,
  (newStatuses) => {
    const next: Record<string, ColorPickerState> = {}
    for (const status of newStatuses) {
      const override = getOverride(status.name)
      next[status.name] = {
        useGradient: !!override?.to,
        from: override?.from ?? getDefaultFrom(status.category),
        to: override?.to ?? '#ffffff',
      }
    }
    localColors.value = next
  },
  { immediate: true }
)

function colorState(name: string): ColorPickerState {
  return localColors.value[name] ?? { useGradient: false, from: '#3b82f6', to: '#ffffff' }
}

function applyColor(name: string, patch: Partial<ColorPickerState>) {
  const next = { ...colorState(name), ...patch }
  localColors.value[name] = next
  setOverride(name, { from: next.from, to: next.useGradient ? next.to : undefined })
}

function resetOverride(name: string) {
  removeOverride(name)
  const status = statuses.value.find((s) => s.name === name)
  if (status) {
    localColors.value[name] = { useGradient: false, from: getDefaultFrom(status.category), to: '#ffffff' }
  }
}

const categoryOrder = ['active', 'wip', 'done', 'frozen'] as const
const categoryLabels = computed<Record<string, string>>(() => ({
  active: t('settings.statusColors.categories.active'),
  wip: t('settings.statusColors.categories.wip'),
  done: t('settings.statusColors.categories.done'),
  frozen: t('settings.statusColors.categories.frozen'),
}))

const groupedStatuses = computed(() => {
  const groups: Array<{ category: string; label: string; statuses: typeof statuses.value }> = []
  const byCategory = new Map<string, typeof statuses.value>()
  for (const s of statuses.value) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, [])
    byCategory.get(s.category)!.push(s)
  }
  for (const cat of categoryOrder) {
    const list = byCategory.get(cat)
    if (list?.length) {
      groups.push({ category: cat, label: categoryLabels.value[cat] ?? cat, statuses: list })
      byCategory.delete(cat)
    }
  }
  for (const [cat, list] of byCategory) {
    if (list.length) groups.push({ category: cat, label: cat, statuses: list })
  }
  return groups
})
</script>

<template>
  <div class="space-y-3">
    <div>
      <Label>{{ t('settings.statusColors.title') }}</Label>
      <p class="text-xs text-muted-foreground mt-0.5 text-pretty">
        {{ t('settings.statusColors.description') }}
      </p>
    </div>

    <div v-if="statuses.length === 0" class="text-xs text-muted-foreground py-2">
      {{ t('settings.statusColors.loading') }}
    </div>

    <div v-else class="space-y-4">
      <div v-for="group in groupedStatuses" :key="group.category" class="space-y-2">
        <h3 class="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {{ group.label }}
        </h3>
        <div class="space-y-2">
          <div
            v-for="status in group.statuses"
            :key="status.name"
            class="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5"
            :class="!!getOverride(status.name) ? 'border-primary/30 bg-primary/5' : ''"
          >
            <div class="shrink-0 w-24">
              <StatusBadge :status="status.name as IssueStatus" size="sm" />
            </div>

            <div class="flex items-center gap-1.5 flex-1 min-w-0">
              <div class="flex items-center gap-1">
                <label :for="`color-from-${status.name}`" class="text-[10px] text-muted-foreground shrink-0">
                  {{ colorState(status.name).useGradient ? t('settings.statusColors.from') : t('settings.statusColors.color') }}
                </label>
                <input
                  :id="`color-from-${status.name}`"
                  :value="colorState(status.name).from"
                  type="color"
                  class="size-6 rounded cursor-pointer border border-border/50 p-0.5 bg-transparent"
                  :title="t('settings.statusColors.primaryColorTitle', { label: status.label })"
                  @input="applyColor(status.name, { from: ($event.target as HTMLInputElement).value })"
                />
              </div>

              <div class="flex items-center gap-1">
                <input
                  :id="`gradient-${status.name}`"
                  :checked="colorState(status.name).useGradient"
                  type="checkbox"
                  class="size-4 rounded cursor-pointer accent-primary"
                  :title="t('settings.statusColors.enableGradientTitle', { label: status.label })"
                  @change="applyColor(status.name, { useGradient: ($event.target as HTMLInputElement).checked })"
                />
                <label :for="`gradient-${status.name}`" class="text-[10px] text-muted-foreground cursor-pointer select-none">
                  {{ t('settings.statusColors.gradient') }}
                </label>
                <label
                  v-if="colorState(status.name).useGradient"
                  :for="`color-to-${status.name}`"
                  class="sr-only"
                >
                  {{ t('settings.statusColors.gradientEndSr', { label: status.label }) }}
                </label>
                <input
                  v-if="colorState(status.name).useGradient"
                  :id="`color-to-${status.name}`"
                  :value="colorState(status.name).to"
                  type="color"
                  class="size-6 rounded cursor-pointer border border-border/50 p-0.5 bg-transparent"
                  :title="t('settings.statusColors.gradientEndTitle', { label: status.label })"
                  @input="applyColor(status.name, { to: ($event.target as HTMLInputElement).value })"
                />
              </div>
            </div>

            <Button
              variant="ghost"
              size="sm"
              class="h-6 px-1.5 text-[10px] shrink-0"
              :disabled="!getOverride(status.name)"
              :aria-label="t('settings.statusColors.resetAria', { label: status.label })"
              @click="resetOverride(status.name)"
            >
              {{ t('settings.statusColors.reset') }}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
