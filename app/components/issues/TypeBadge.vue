<script setup lang="ts">
import type { IssueType } from '~/types/issue'
import { Badge } from '~/components/ui/badge'

const props = defineProps<{
  type: IssueType
  size?: 'default' | 'sm'
}>()

const { t } = useI18n()
const { showBadgeIcons } = useTheme()

const typeConfig: Record<IssueType, { label: string; class: string }> = {
  bug: { label: 'BUG', class: 'badge-gradient bg-type-bug-gradient text-white' },
  task: { label: 'TASK', class: 'badge-gradient bg-type-task-gradient text-white' },
  feature: { label: 'FEATURE', class: 'badge-gradient bg-type-feature-gradient text-white' },
  epic: { label: 'EPIC', class: 'badge-gradient bg-type-epic-gradient text-white' },
  chore: { label: 'CHORE', class: 'badge-gradient bg-type-chore-gradient text-white' },
  spike: { label: 'SPIKE', class: 'badge-gradient bg-muted text-muted-foreground border border-border' },
  story: { label: 'STORY', class: 'badge-gradient bg-muted text-muted-foreground border border-border' },
  milestone: { label: 'MILESTONE', class: 'badge-gradient bg-muted text-muted-foreground border border-border' },
}

// SVG icon paths for each type (12x12 viewBox)
const typeIcons: Record<IssueType, string> = {
  bug: 'M4.5 1.5L3 3M7.5 1.5L9 3M1 5h2M9 5h2M1 8h2M9 8h2M3 3.5a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0v-5z',
  task: 'M3 1h6v10H3V1zM5 3.5h2M5 5.5h2M5 7.5h1',
  feature: 'M6 1l1.5 3.2L11 4.8 8.2 7.3l.7 3.7L6 9.2 3.1 11l.7-3.7L1 4.8l3.5-.6L6 1z',
  epic: 'M4 1v4l-3 2 3 2v4l4-3 4 3V9l3-2-3-2V1L8 4 4 1z',
  chore: 'M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 1v1M6 10v1M1 6h1M10 6h1M2.5 2.5l.7.7M8.8 8.8l.7.7M9.5 2.5l-.7.7M3.2 8.8l-.7.7',
  spike: 'M6 1v2M6 9v2M2 3l1.5 1.5M8.5 7.5L10 9M1 6h2M9 6h2M2 9l1.5-1.5M8.5 4.5L10 3M4.5 4.5a2.1 2.1 0 1 0 3 3 2.1 2.1 0 0 0-3-3z',
  story: 'M2 1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zM1 3h5M1 3v8M6 3v8M4 1v2M4 6l-2 2M4 6l2 2',
  milestone: 'M2 2v10M2 2l7 3-7 3',
}

const config = computed(() => typeConfig[props.type] || typeConfig.task)
</script>

<template>
  <Badge :class="[config.class, size === 'sm' ? 'text-[10px] px-1.5 py-0' : '']" variant="secondary" :aria-label="t('issues.badges.typeAria', { type })">
    <span v-if="showBadgeIcons" class="inline-flex items-center mr-1">
      <svg class="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path :d="typeIcons[type] || typeIcons.task" />
      </svg>
    </span>
    {{ config.label }}
  </Badge>
</template>
