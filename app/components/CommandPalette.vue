<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import {
  Dialog,
  DialogContent,
} from '~/components/ui/dialog'
import { useCommandPalette } from '~/composables/useCommandPalette'
import type { PaletteResult } from '~/composables/useCommandPalette'

const { t } = useI18n()
const {
  open,
  query,
  loading,
  errors,
  focusedIndex,
  results,
  closePalette,
  onArrowDown,
  onArrowUp,
} = useCommandPalette()

const emit = defineEmits<{
  select: [payload: { id: string; path: string }]
}>()

const inputRef = ref<HTMLInputElement | null>(null)

// Autofocus input when palette opens
watch(open, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    inputRef.value?.focus()
  }
})

// Scroll focused item into view when focusedIndex changes
watch(focusedIndex, async (idx) => {
  await nextTick()
  const el = document.getElementById(`palette-item-${idx}`)
  el?.scrollIntoView({ block: 'nearest' })
})

// Флаг для предотвращения прыжков фокуса при клавиатурной навигации
const lastNavWasKeyboard = ref(false)
let mouseMoveSinceKeyboard = 0

function onMouseMove(i: number) {
  mouseMoveSinceKeyboard++
  // Игнорировать первый mousemove после стрелки — курсор мог не двигаться
  if (lastNavWasKeyboard.value && mouseMoveSinceKeyboard <= 1) return
  lastNavWasKeyboard.value = false
  focusedIndex.value = i
}

function handleKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    lastNavWasKeyboard.value = true
    mouseMoveSinceKeyboard = 0
    onArrowDown()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    lastNavWasKeyboard.value = true
    mouseMoveSinceKeyboard = 0
    onArrowUp()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const result = results.value[focusedIndex.value]
    if (result) selectResult(result)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closePalette()
  }
}

function selectResult(r: PaletteResult) {
  emit('select', { id: r.issue.id, path: r.projectPath })
}

// Вычислить отображаемые бейджи статуса
function statusClass(status: string): string {
  const map: Record<string, string> = {
    open: 'bg-muted text-muted-foreground',
    in_progress: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    inreview: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
    closed: 'bg-muted text-muted-foreground line-through',
    blocked: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    deferred: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  }
  return map[status] ?? 'bg-muted text-muted-foreground'
}

function priorityClass(priority: string): string {
  const map: Record<string, string> = {
    p0: 'text-red-600 dark:text-red-400',
    p1: 'text-orange-600 dark:text-orange-400',
    p2: 'text-yellow-600 dark:text-yellow-500',
    p3: 'text-muted-foreground',
    p4: 'text-muted-foreground opacity-60',
  }
  return map[priority.toLowerCase()] ?? 'text-muted-foreground'
}

const { projects } = useFavorites()
const hasProjects = computed(() => projects.value.length > 0)
</script>

<template>
  <Dialog :open="open" @update:open="(v) => !v && closePalette()">
    <DialogContent
      class="p-0 gap-0 max-w-2xl overflow-hidden"
      :show-close-button="false"
      :aria-label="t('commandPalette.title')"
    >
      <!-- Search input -->
      <div class="flex items-center border-b px-3">
        <svg
          class="w-4 h-4 text-muted-foreground shrink-0 mr-2"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref="inputRef"
          v-model="query"
          role="combobox"
          :aria-label="t('commandPalette.placeholder')"
          aria-autocomplete="list"
          aria-controls="palette-list"
          :aria-activedescendant="results.length > 0 ? `palette-item-${focusedIndex}` : undefined"
          :aria-expanded="results.length > 0"
          type="text"
          :placeholder="t('commandPalette.placeholder')"
          class="flex-1 py-3 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
          @keydown="handleKey"
        />
        <kbd class="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground border rounded ml-2">
          Esc
        </kbd>
      </div>

      <!-- Results -->
      <div class="relative">
        <!-- Loading -->
        <div v-if="loading" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
          {{ t('commandPalette.loading') }}
        </div>

        <!-- Empty projects state -->
        <div v-else-if="!hasProjects" class="py-8 px-4 text-center text-sm text-muted-foreground text-pretty">
          {{ t('commandPalette.emptyProjectsPrompt') }}
        </div>

        <!-- Empty query -->
        <div v-else-if="!query.trim()" class="py-8 px-4 text-center text-sm text-muted-foreground">
          {{ t('commandPalette.emptyPrompt') }}
        </div>

        <!-- No results -->
        <div v-else-if="results.length === 0" class="py-8 px-4 text-center text-sm text-muted-foreground">
          {{ t('commandPalette.noResults') }}
        </div>

        <!-- Results list -->
        <ul
          v-else
          id="palette-list"
          role="listbox"
          :aria-label="t('commandPalette.title')"
          class="max-h-80 overflow-y-auto py-1"
        >
          <li
            v-for="(r, i) in results"
            :id="`palette-item-${i}`"
            :key="`${r.projectPath}::${r.issue.id}`"
            role="option"
            :aria-selected="i === focusedIndex"
            class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-sm transition-colors"
            :class="i === focusedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'"
            @click="selectResult(r)"
            @mousemove="onMouseMove(i)"
          >
            <!-- ID -->
            <span class="font-mono text-xs text-muted-foreground shrink-0 truncate max-w-32">
              {{ r.issue.id }}
            </span>

            <!-- Title -->
            <span class="flex-1 truncate text-pretty">{{ r.issue.title }}</span>

            <!-- Badges -->
            <div class="flex items-center gap-1 shrink-0">
              <!-- Status badge -->
              <span
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
                :class="statusClass(r.issue.status)"
              >
                {{ r.issue.status.replace('_', '\u200b_') }}
              </span>

              <!-- Priority badge -->
              <span
                class="text-[10px] font-mono font-semibold uppercase tabular-nums"
                :class="priorityClass(r.issue.priority)"
              >
                {{ r.issue.priority.toUpperCase() }}
              </span>

              <!-- Project badge -->
              <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground truncate max-w-24">
                <svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {{ r.projectName }}
              </span>
            </div>
          </li>
        </ul>

        <!-- Errors badge -->
        <div
          v-if="errors.length > 0"
          class="px-3 py-1.5 border-t text-[11px] text-destructive bg-destructive/5 flex items-center gap-1"
        >
          <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {{ errors.length }} {{ errors.length === 1 ? t('commandPalette.error', { project: errors[0] }) : `${errors.length} projects failed to load` }}
        </div>
      </div>

      <!-- Footer hint -->
      <div class="border-t px-3 py-1.5 text-[10px] text-muted-foreground flex justify-end">
        {{ t('commandPalette.hint') }}
      </div>
    </DialogContent>
  </Dialog>
</template>
