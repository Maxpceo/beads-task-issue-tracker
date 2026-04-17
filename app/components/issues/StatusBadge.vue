<script setup lang="ts">
import type { IssueStatus } from '~/types/issue'
import { Badge } from '~/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import { useStatuses } from '~/composables/useStatuses'
import { useStatusColorOverrides } from '~/composables/useStatusColorOverrides'

const props = defineProps<{
  status: IssueStatus
  size?: 'default' | 'sm'
  blockedBy?: string[]
}>()

const { showBadgeIcons } = useTheme()
const { getMeta } = useStatuses()
const { getOverride } = useStatusColorOverrides()

const config = computed(() => {
  const meta = getMeta(props.status)
  const label = meta
    ? meta.label
    : props.status.toUpperCase().replace(/_/g, ' ')
  const icon = meta?.icon

  // Priority 1: user color override — emit inline style, no gradient class
  const override = getOverride(props.status)
  if (override) {
    const background = override.to
      ? `linear-gradient(135deg, ${override.from}, ${override.to})`
      : override.from
    return { label, icon, class: 'text-white', style: { background } }
  }

  // Priority 2: built-in or category class (existing logic)
  if (!meta) {
    return {
      label,
      icon,
      class: 'badge-gradient bg-status-category-active-gradient text-white',
      style: undefined,
    }
  }
  const cls = meta.isBuiltIn
    ? `badge-gradient bg-status-${meta.name.replace(/_/g, '-')}-gradient text-white`
    : `badge-gradient bg-status-category-${meta.category}-gradient text-white`
  return { label, icon, class: cls, style: undefined }
})

const showBlockedTooltip = computed(() => props.blockedBy?.length && props.status === 'blocked')
</script>

<template>
  <Tooltip v-if="showBlockedTooltip">
    <TooltipTrigger as-child>
      <Badge
        :class="[config.class, size === 'sm' ? 'text-[10px] px-1.5 py-0' : '']"
        :style="config.style"
        variant="secondary"
      >
        <span v-if="showBadgeIcons && config.icon" class="inline-flex items-center mr-1" aria-hidden="true">
          {{ config.icon }}
        </span>
        {{ config.label }}
      </Badge>
    </TooltipTrigger>
    <TooltipContent side="top">
      <p class="text-xs">Blocked by {{ blockedBy!.join(', ') }}</p>
    </TooltipContent>
  </Tooltip>
  <Badge
    v-else
    :class="[config.class, size === 'sm' ? 'text-[10px] px-1.5 py-0' : '']"
    :style="config.style"
    variant="secondary"
  >
    <span v-if="showBadgeIcons && config.icon" class="inline-flex items-center mr-1" aria-hidden="true">
      {{ config.icon }}
    </span>
    {{ config.label }}
  </Badge>
</template>
