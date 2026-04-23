<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Palette, Terminal, Monitor, Paintbrush, Zap } from 'lucide-vue-next'
import SettingsAppearance from '~/components/layout/settings/SettingsAppearance.vue'
import SettingsCliClient from '~/components/layout/settings/SettingsCliClient.vue'
import SettingsDisplay from '~/components/layout/settings/SettingsDisplay.vue'
import SettingsStatusColors from '~/components/layout/settings/SettingsStatusColors.vue'
import SettingsProbe from '~/components/layout/settings/SettingsProbe.vue'

const { t } = useI18n()
const open = defineModel<boolean>('open', { default: false })

const isDev = import.meta.dev

type SectionId = 'appearance' | 'cli' | 'display' | 'colors' | 'probe'

const sections = computed(() => {
  const list: Array<{ id: SectionId; icon: typeof Palette; labelKey: string }> = [
    { id: 'appearance', icon: Palette, labelKey: 'settings.sections.appearance' },
    { id: 'cli', icon: Terminal, labelKey: 'settings.sections.cli' },
    { id: 'display', icon: Monitor, labelKey: 'settings.sections.display' },
    { id: 'colors', icon: Paintbrush, labelKey: 'settings.sections.colors' },
  ]
  if (isDev) list.push({ id: 'probe', icon: Zap, labelKey: 'settings.sections.probe' })
  return list
})

const activeSection = useLocalStorage<SectionId>('beads:settingsTab', 'appearance')

watch(open, (isOpen) => {
  if (isOpen && activeSection.value === 'probe' && !isDev) {
    activeSection.value = 'appearance'
  }
})

</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-3xl p-0 overflow-hidden">
      <div class="grid grid-cols-[180px_1fr] min-h-[480px] max-h-[80dvh]">
        <!-- Sidebar -->
        <nav
          class="border-r border-border/60 bg-muted/30 p-3 flex flex-col gap-1"
          :aria-label="t('settings.sections.navigationLabel')"
        >
          <DialogHeader class="text-left p-2 pb-3 space-y-0.5">
            <DialogTitle class="text-base">{{ t('settings.title') }}</DialogTitle>
            <DialogDescription class="text-xs text-pretty">
              {{ t('settings.description') }}
            </DialogDescription>
          </DialogHeader>

          <button
            v-for="section in sections"
            :key="section.id"
            type="button"
            class="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="activeSection === section.id
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-foreground hover:bg-muted'"
            :aria-current="activeSection === section.id ? 'page' : undefined"
            @click="activeSection = section.id"
          >
            <component :is="section.icon" class="size-4 shrink-0" aria-hidden="true" />
            <span class="truncate">{{ t(section.labelKey) }}</span>
          </button>
        </nav>

        <!-- Content panel -->
        <div class="overflow-y-auto p-6 pr-10">
          <SettingsAppearance v-if="activeSection === 'appearance'" />
          <SettingsCliClient v-else-if="activeSection === 'cli'" />
          <SettingsDisplay v-else-if="activeSection === 'display'" />
          <SettingsStatusColors v-else-if="activeSection === 'colors'" />
          <SettingsProbe v-else-if="activeSection === 'probe' && isDev" />
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
