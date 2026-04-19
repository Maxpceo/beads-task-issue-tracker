<script setup lang="ts">
import { Label } from '~/components/ui/label'
import { useLocale } from '~/composables/useLocale'

const { t } = useI18n()
const { theme: activeTheme, themes, setTheme } = useTheme()
const { locale, isAuto, setLocale } = useLocale()
const currentValue = computed(() => (isAuto.value ? 'auto' : locale.value))

function onLanguageChange(value: 'auto' | 'en' | 'ru') {
  setLocale(value)
}

const themeIconPaths: Record<string, string> = {
  sun: 'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  square: '',
  zap: 'M13 2L3 14h9l-1 10 10-12h-9l1-10z',
}
const sunCircle = { cx: 12, cy: 12, r: 5 }
</script>

<template>
  <div class="space-y-6">
    <!-- Theme -->
    <div class="space-y-3">
      <Label>{{ t('settings.theme') }}</Label>
      <div class="grid grid-cols-4 gap-3">
        <button
          v-for="th in themes"
          :key="th.id"
          class="relative flex flex-col items-center gap-1.5 rounded-lg border-2 p-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          :class="activeTheme === th.id
            ? 'border-primary bg-primary/5'
            : 'border-muted hover:border-muted-foreground/25 hover:bg-muted/50'"
          @click="setTheme(th.id)"
        >
          <div class="flex items-center justify-center h-8 w-8">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle v-if="th.icon === 'sun'" v-bind="sunCircle" />
              <rect v-if="th.icon === 'square'" x="3" y="3" width="18" height="18" rx="2" />
              <path v-if="themeIconPaths[th.icon]" :d="themeIconPaths[th.icon]" />
            </svg>
          </div>
          <span class="text-xs font-medium">{{ th.label }}</span>
          <div
            class="absolute top-1.5 right-1.5 h-2 w-2 rounded-full transition-colors"
            :class="activeTheme === th.id ? 'bg-primary' : 'bg-transparent'"
          />
        </button>
      </div>
    </div>

    <!-- Language -->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-medium">{{ t('settings.language.title') }}</h3>
        <p class="text-xs text-muted-foreground text-pretty">{{ t('settings.language.description') }}</p>
      </div>
      <div class="flex flex-col gap-2 max-w-xs" role="radiogroup" :aria-label="t('settings.language.title')">
        <label class="flex items-center gap-2 cursor-pointer rounded-md border px-3 py-2 hover:bg-accent transition-colors" :class="currentValue === 'auto' ? 'border-primary bg-accent' : 'border-input'">
          <input type="radio" name="locale" value="auto" class="accent-primary" :checked="currentValue === 'auto'" @change="onLanguageChange('auto')">
          <span class="text-sm">
            {{ t('settings.language.auto') }}
            <span v-if="isAuto" class="text-muted-foreground ml-1">({{ locale === 'ru' ? t('settings.language.russian') : t('settings.language.english') }})</span>
          </span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer rounded-md border px-3 py-2 hover:bg-accent transition-colors" :class="currentValue === 'en' ? 'border-primary bg-accent' : 'border-input'">
          <input type="radio" name="locale" value="en" class="accent-primary" :checked="currentValue === 'en'" @change="onLanguageChange('en')">
          <span class="text-sm">{{ t('settings.language.english') }}</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer rounded-md border px-3 py-2 hover:bg-accent transition-colors" :class="currentValue === 'ru' ? 'border-primary bg-accent' : 'border-input'">
          <input type="radio" name="locale" value="ru" class="accent-primary" :checked="currentValue === 'ru'" @change="onLanguageChange('ru')">
          <span class="text-sm">{{ t('settings.language.russian') }}</span>
        </label>
      </div>
    </section>
  </div>
</template>
