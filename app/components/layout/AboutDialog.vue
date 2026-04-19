<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'

const open = defineModel<boolean>('open', { default: false })

const appVersion = useRuntimeConfig().public.appVersion
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader class="items-center text-center">
        <img
          :src="'/icon.png'"
          :alt="$t('app.title')"
          class="w-16 h-16 mb-2"
        />
        <DialogTitle class="text-lg">{{ $t('app.title') }}</DialogTitle>
        <DialogDescription as="div" class="space-y-3 pt-2">
          <p class="text-sm font-medium text-foreground">{{ $t('about.version', { version: appVersion }) }}</p>
          <div class="text-xs text-muted-foreground space-y-1">
            <p>&copy; 2026 Maksim Posudevskii</p>
            <p>{{ $t('about.poweredBy') }}</p>
            <p>{{ $t('about.vibeCoded') }}</p>
          </div>
        </DialogDescription>
      </DialogHeader>
    </DialogContent>
  </Dialog>
</template>
