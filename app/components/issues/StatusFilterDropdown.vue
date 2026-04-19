<script setup lang="ts">
import type { IssueStatus } from '~/types/issue'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import StatusBadge from '~/components/issues/StatusBadge.vue'
import { useStatuses } from '~/composables/useStatuses'

const props = defineProps<{
  selectedStatuses: IssueStatus[]
  open?: boolean
}>()

defineEmits<{
  toggle: [status: IssueStatus]
  'update:open': [value: boolean]
}>()

const { t } = useI18n()
const { statuses } = useStatuses()

const isSelected = (status: IssueStatus) => props.selectedStatuses.includes(status)
</script>

<template>
  <Tooltip>
    <DropdownMenu :open="open" :modal="false" @update:open="$emit('update:open', $event)">
      <TooltipTrigger as-child>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm" class="h-8 text-xs gap-1">
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            {{ t('issues.filters.status') }}
            <span
              v-if="selectedStatuses.length > 0"
              class="ml-0.5 rounded-full bg-primary text-primary-foreground text-[10px] px-1.5 min-w-[18px] text-center"
            >
              {{ selectedStatuses.length }}
            </span>
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent>{{ t('issues.filters.filterByStatus') }}</TooltipContent>
      <DropdownMenuContent align="start" class="w-40">
        <DropdownMenuCheckboxItem
          v-for="s in statuses"
          :key="s.name"
          :model-value="isSelected(s.name)"
          class="text-xs cursor-pointer"
          @select.prevent="$emit('toggle', s.name)"
        >
          <StatusBadge :status="s.name" size="sm" />
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </Tooltip>
</template>
