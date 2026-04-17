<script setup lang="ts">
import type { IssueStatus } from '~/types/issue'
import { Badge } from '~/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import { useStatuses } from '~/composables/useStatuses'

const props = defineProps<{
  status: IssueStatus
  size?: 'default' | 'sm'
  blockedBy?: string[]
}>()

const { showBadgeIcons } = useTheme()
const { getMeta } = useStatuses()

// Derive badge class and label from StatusMeta
const config = computed(() => {
  const meta = getMeta(props.status)
  if (!meta) {
    // Unknown status — fall back to active-category gradient, show raw name
    return {
      label: props.status.toUpperCase().replace(/_/g, ' '),
      class: 'badge-gradient bg-status-category-active-gradient text-white',
      icon: undefined as string | undefined,
    }
  }
  const cls = meta.isBuiltIn
    ? `badge-gradient bg-status-${meta.name.replace(/_/g, '-')}-gradient text-white`
    : `badge-gradient bg-status-category-${meta.category}-gradient text-white`
  return {
    label: meta.label,
    class: cls,
    icon: meta.icon,
  }
})

const showBlockedTooltip = computed(() => props.blockedBy?.length && props.status === 'blocked')
</script>

<template>
  <Tooltip v-if="showBlockedTooltip">
    <TooltipTrigger as-child>
      <Badge :class="[config.class, size === 'sm' ? 'text-[10px] px-1.5 py-0' : '']" variant="secondary">
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
  <Badge v-else :class="[config.class, size === 'sm' ? 'text-[10px] px-1.5 py-0' : '']" variant="secondary">
    <span v-if="showBadgeIcons && config.icon" class="inline-flex items-center mr-1" aria-hidden="true">
      {{ config.icon }}
    </span>
    {{ config.label }}
  </Badge>
</template>
