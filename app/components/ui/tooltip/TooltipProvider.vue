<script setup lang="ts">
import type { TooltipProviderProps } from "reka-ui"
import { TooltipProvider } from "reka-ui"

// Inherit reka-ui defaults: delayDuration=700ms, skipDelayDuration=300ms
// (matches macOS HIG / Linear / GitHub). Per-tooltip override via prop.
const props = defineProps<TooltipProviderProps>()
</script>

<template>
  <TooltipProvider v-bind="props">
    <slot />
  </TooltipProvider>
</template>
