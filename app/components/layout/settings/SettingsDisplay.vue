<script setup lang="ts">
import { Label } from '~/components/ui/label'

const { t } = useI18n()
const { floatActiveToTop } = useIssues()
</script>

<template>
  <div class="space-y-3">
    <Label>{{ t('settings.display.title') }}</Label>
    <div class="flex items-start gap-3 rounded-md border border-border/50 px-3 py-2.5">
      <input
        id="float-active-to-top"
        v-model="floatActiveToTop"
        type="checkbox"
        class="mt-0.5 size-4 shrink-0 rounded cursor-pointer accent-primary"
      />
      <div class="flex flex-col gap-0.5">
        <label for="float-active-to-top" class="text-sm font-medium cursor-pointer select-none leading-tight">
          {{ t('settings.display.floatActiveLabel') }}
        </label>
        <p class="text-xs text-muted-foreground text-pretty">
          {{ t('settings.display.floatActiveDescription') }}
        </p>
      </div>
    </div>
  </div>
</template>
