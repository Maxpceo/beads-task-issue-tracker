<script setup lang="ts">
import { useMultiCopy } from '~/composables/useMultiCopy'

const props = defineProps<{
  value: string
  displayValue?: string
}>()

const { copyIssueId, isCopied } = useMultiCopy()

const handleClick = (event: MouseEvent) => {
  copyIssueId(props.value, event)
}
</script>

<template>
  <button
    class="flex items-center gap-1 text-[10px] text-muted-foreground font-mono hover:text-foreground transition-colors"
    :title="`Copy ${props.value} (⌘/Ctrl+click to add to buffer)`"
    :aria-label="`Copy ${props.value}, hold Cmd or Ctrl to add to multi-copy buffer`"
    @click="handleClick"
  >
    {{ displayValue ?? value }}
    <svg
      v-if="!isCopied(props.value)"
      class="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
    <svg
      v-else
      class="w-3 h-3 text-green-500"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  </button>
</template>
