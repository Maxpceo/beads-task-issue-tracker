<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Label } from '~/components/ui/label'
import { Button } from '~/components/ui/button'
import { getCliBinaryPath, setCliBinaryPath, checkExternalHealth } from '~/utils/bd-api'
import type { ThemeDefinition } from '~/composables/useTheme'
import { useStatuses } from '~/composables/useStatuses'
import { useStatusColorOverrides } from '~/composables/useStatusColorOverrides'
import StatusBadge from '~/components/issues/StatusBadge.vue'

const open = defineModel<boolean>('open', { default: false })

const { theme: activeTheme, themes, setTheme } = useTheme()

// SVG icons for theme cards
const themeIconPaths: Record<string, string> = {
  sun: 'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  square: '', // uses rect element instead
  zap: 'M13 2L3 14h9l-1 10 10-12h-9l1-10z',
}
// Sun needs a separate circle
const sunCircle = { cx: 12, cy: 12, r: 5 }

const selectedClient = ref<'bd' | 'br'>('bd')
const isSwitching = ref(false)
const switchResult = ref<{ success: boolean; message: string } | null>(null)

// Probe settings (dev-only — hidden in production until probe is a public feature)
const isDev = import.meta.dev
const probeEnabled = useLocalStorage('beads:probeEnabled', false)
const dataSourceUrl = useLocalStorage('beads:dataSourceUrl', 'http://localhost:9100')
const isTesting = ref(false)
const healthResult = ref<boolean | null>(null)

// Status color overrides
const { statuses } = useStatuses()
const { getOverride, setOverride, removeOverride } = useStatusColorOverrides()

// Local state for the color pickers — initialized from overrides or defaults
interface ColorPickerState {
  useGradient: boolean
  from: string
  to: string
}

const DEFAULT_FROM: Record<string, string> = {
  active: '#3b82f6',
  wip: '#8b5cf6',
  done: '#22c55e',
  frozen: '#6b7280',
}

function getDefaultFrom(category: string): string {
  return DEFAULT_FROM[category] ?? '#3b82f6'
}

// Mutable local copy for picker interaction — built once when statuses load
const localColors = ref<Record<string, ColorPickerState>>({})

// Sync localColors when statuses change (e.g. first load)
watch(
  statuses,
  (newStatuses) => {
    const next: Record<string, ColorPickerState> = {}
    for (const status of newStatuses) {
      const override = getOverride(status.name)
      next[status.name] = {
        useGradient: !!override?.to,
        from: override?.from ?? getDefaultFrom(status.category),
        to: override?.to ?? '#ffffff',
      }
    }
    localColors.value = next
  },
  { immediate: true }
)

// Safe accessor — guarantees a ColorPickerState even if localColors[name] is not yet set
function colorState(name: string): ColorPickerState {
  return localColors.value[name] ?? { useGradient: false, from: '#3b82f6', to: '#ffffff' }
}

function applyColor(name: string, patch: Partial<ColorPickerState>) {
  const next = { ...colorState(name), ...patch }
  localColors.value[name] = next
  setOverride(name, { from: next.from, to: next.useGradient ? next.to : undefined })
}

function resetOverride(name: string) {
  removeOverride(name)
  const status = statuses.value.find((s) => s.name === name)
  if (status) {
    localColors.value[name] = { useGradient: false, from: getDefaultFrom(status.category), to: '#ffffff' }
  }
}

// Load current setting when dialog opens
watch(open, async (isOpen) => {
  if (isOpen) {
    try {
      const current = await getCliBinaryPath()
      selectedClient.value = current === 'br' ? 'br' : 'bd'
      switchResult.value = null
    } catch {
      selectedClient.value = 'bd'
    }
    healthResult.value = null
  }
})

async function selectClient(client: 'bd' | 'br') {
  if (client === selectedClient.value) return

  isSwitching.value = true
  switchResult.value = null
  try {
    const version = await setCliBinaryPath(client)
    selectedClient.value = client
    switchResult.value = { success: true, message: version }
    // Update shared CLI client state
    const { setBinary } = useCliClient()
    setBinary(client)
  } catch (error) {
    switchResult.value = {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    isSwitching.value = false
  }
}

async function testConnection() {
  isTesting.value = true
  healthResult.value = null
  try {
    healthResult.value = await checkExternalHealth(dataSourceUrl.value)
  } catch {
    healthResult.value = false
  } finally {
    isTesting.value = false
  }
}

// Group statuses by category for display
const categoryOrder = ['active', 'wip', 'done', 'frozen'] as const
const categoryLabels: Record<string, string> = {
  active: 'Active',
  wip: 'In Progress',
  done: 'Done',
  frozen: 'Frozen / Deferred',
}

const groupedStatuses = computed(() => {
  const groups: Array<{ category: string; label: string; statuses: typeof statuses.value }> = []
  const byCategory = new Map<string, typeof statuses.value>()

  for (const s of statuses.value) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, [])
    byCategory.get(s.category)!.push(s)
  }

  // Known categories in order
  for (const cat of categoryOrder) {
    const list = byCategory.get(cat)
    if (list?.length) {
      groups.push({ category: cat, label: categoryLabels[cat] ?? cat, statuses: list })
      byCategory.delete(cat)
    }
  }

  // Any remaining (custom categories)
  for (const [cat, list] of byCategory) {
    if (list.length) {
      groups.push({ category: cat, label: cat, statuses: list })
    }
  }

  return groups
})

</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>
          Choose which CLI client to use for issue management.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-6 pt-2">
        <!-- Theme Selector -->
        <div class="space-y-3">
          <Label>Theme</Label>
          <div class="grid grid-cols-4 gap-3">
            <button
              v-for="t in themes"
              :key="t.id"
              class="relative flex flex-col items-center gap-1.5 rounded-lg border-2 p-3 text-center transition-colors"
              :class="activeTheme === t.id
                ? 'border-primary bg-primary/5'
                : 'border-muted hover:border-muted-foreground/25 hover:bg-muted/50'"
              @click="setTheme(t.id)"
            >
              <div class="flex items-center justify-center h-8 w-8">
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle v-if="t.icon === 'sun'" v-bind="sunCircle" />
                  <rect v-if="t.icon === 'square'" x="3" y="3" width="18" height="18" rx="2" />
                  <path v-if="themeIconPaths[t.icon]" :d="themeIconPaths[t.icon]" />
                </svg>
              </div>
              <span class="text-xs font-medium">{{ t.label }}</span>
              <div
                class="absolute top-1.5 right-1.5 h-2 w-2 rounded-full transition-colors"
                :class="activeTheme === t.id ? 'bg-primary' : 'bg-transparent'"
              />
            </button>
          </div>
        </div>

        <!-- CLI Client Selector -->
        <div class="space-y-3">
          <Label>CLI Client</Label>
          <div class="grid grid-cols-2 gap-3">
            <!-- br option (preferred) -->
            <button
              class="relative flex flex-col items-start gap-1.5 rounded-lg border-2 p-3 text-left transition-colors"
              :class="selectedClient === 'br'
                ? 'border-primary bg-primary/5'
                : 'border-muted hover:border-muted-foreground/25 hover:bg-muted/50'"
              :disabled="isSwitching"
              @click="selectClient('br')"
            >
              <div class="flex items-center gap-2">
                <div
                  class="flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors"
                  :class="selectedClient === 'br' ? 'border-primary' : 'border-muted-foreground/40'"
                >
                  <div
                    v-if="selectedClient === 'br'"
                    class="h-2.5 w-2.5 rounded-full bg-primary"
                  />
                </div>
                <span class="font-mono font-semibold text-sm">br</span>
              </div>
              <p class="text-xs text-muted-foreground pl-7">
                Beads Rust (SQLite + JSONL)
              </p>
            </button>

            <!-- bd option (legacy) -->
            <button
              class="relative flex flex-col items-start gap-1.5 rounded-lg border-2 p-3 text-left transition-colors"
              :class="selectedClient === 'bd'
                ? 'border-primary bg-primary/5'
                : 'border-muted hover:border-muted-foreground/25 hover:bg-muted/50'"
              :disabled="isSwitching"
              @click="selectClient('bd')"
            >
              <div class="flex items-center gap-2">
                <div
                  class="flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors"
                  :class="selectedClient === 'bd' ? 'border-primary' : 'border-muted-foreground/40'"
                >
                  <div
                    v-if="selectedClient === 'bd'"
                    class="h-2.5 w-2.5 rounded-full bg-primary"
                  />
                </div>
                <span class="font-mono font-semibold text-sm">bd</span>
              </div>
              <p class="text-xs text-muted-foreground pl-7">
                Original Beads CLI (Go)
              </p>
            </button>
          </div>
        </div>

        <!-- Status Colors -->
        <div class="space-y-3">
          <div>
            <Label>Status Colors</Label>
            <p class="text-xs text-muted-foreground mt-0.5">
              Customize badge colors for each status. Changes are local to this project and machine.
            </p>
          </div>

          <div v-if="statuses.length === 0" class="text-xs text-muted-foreground py-2">
            Loading statuses...
          </div>

          <div v-else class="space-y-4">
            <div
              v-for="group in groupedStatuses"
              :key="group.category"
              class="space-y-2"
            >
              <h3 class="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                {{ group.label }}
              </h3>
              <div class="space-y-2">
                <div
                  v-for="status in group.statuses"
                  :key="status.name"
                  class="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5"
                  :class="!!getOverride(status.name) ? 'border-primary/30 bg-primary/5' : ''"
                >
                  <!-- Live preview badge -->
                  <div class="shrink-0 w-24">
                    <StatusBadge :status="status.name as any" size="sm" />
                  </div>

                  <!-- Color pickers -->
                  <div class="flex items-center gap-1.5 flex-1 min-w-0">
                    <!-- From color -->
                    <div class="flex items-center gap-1">
                      <label :for="`color-from-${status.name}`" class="text-[10px] text-muted-foreground shrink-0">
                        {{ colorState(status.name).useGradient ? 'From' : 'Color' }}
                      </label>
                      <input
                        :id="`color-from-${status.name}`"
                        :value="colorState(status.name).from"
                        type="color"
                        class="size-6 rounded cursor-pointer border border-border/50 p-0.5 bg-transparent"
                        :title="`${status.label} primary color`"
                        @input="applyColor(status.name, { from: ($event.target as HTMLInputElement).value })"
                      />
                    </div>

                    <!-- Gradient toggle + to color -->
                    <div class="flex items-center gap-1">
                      <input
                        :id="`gradient-${status.name}`"
                        :checked="colorState(status.name).useGradient"
                        type="checkbox"
                        class="size-4 rounded cursor-pointer accent-primary"
                        :title="`Enable gradient for ${status.label}`"
                        @change="applyColor(status.name, { useGradient: ($event.target as HTMLInputElement).checked })"
                      />
                      <label :for="`gradient-${status.name}`" class="text-[10px] text-muted-foreground cursor-pointer select-none">
                        Grad
                      </label>
                      <label
                        v-if="colorState(status.name).useGradient"
                        :for="`color-to-${status.name}`"
                        class="sr-only"
                      >
                        {{ status.label }} gradient end color
                      </label>
                      <input
                        v-if="colorState(status.name).useGradient"
                        :id="`color-to-${status.name}`"
                        :value="colorState(status.name).to"
                        type="color"
                        class="size-6 rounded cursor-pointer border border-border/50 p-0.5 bg-transparent"
                        :title="`${status.label} gradient end color`"
                        @input="applyColor(status.name, { to: ($event.target as HTMLInputElement).value })"
                      />
                    </div>
                  </div>

                  <!-- Reset button -->
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-6 px-1.5 text-[10px] shrink-0"
                    :disabled="!getOverride(status.name)"
                    :aria-label="`Reset ${status.label} color to default`"
                    @click="resetOverride(status.name)"
                  >
                    Reset
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Probe Toggle (dev-only until probe is a public feature) -->
        <div v-if="isDev" class="space-y-3">
          <div class="flex items-center justify-between">
            <Label>Probe (monitoring broadcast)</Label>
            <button
              class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
              :class="probeEnabled ? 'bg-primary' : 'bg-muted-foreground/30'"
              aria-label="Toggle probe monitoring"
              :aria-pressed="probeEnabled"
              @click="probeEnabled = !probeEnabled; healthResult = null"
            >
              <span
                class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform"
                :class="probeEnabled ? 'translate-x-4.5' : 'translate-x-0.5'"
              />
            </button>
          </div>
          <p class="text-xs text-muted-foreground">
            When enabled, registers projects with the probe for external monitoring.
          </p>

          <!-- URL input + Test connection (visible only when probe enabled) -->
          <div v-if="probeEnabled" class="space-y-2">
            <div class="flex gap-2">
              <input
                v-model="dataSourceUrl"
                type="text"
                placeholder="http://localhost:9100"
                class="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <Button
                size="sm"
                variant="outline"
                :disabled="isTesting"
                @click="testConnection"
              >
                <svg v-if="isTesting" class="animate-spin h-3 w-3 mr-1" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Test connection
              </Button>
            </div>

            <!-- Health check result -->
            <div v-if="healthResult !== null" class="flex items-center gap-1.5 text-xs">
              <svg v-if="healthResult" class="w-3.5 h-3.5 text-green-600 dark:text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg v-else class="w-3.5 h-3.5 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span :class="healthResult ? 'text-green-600 dark:text-green-400' : 'text-destructive'">
                {{ healthResult ? 'Connected' : 'Disconnected' }}
              </span>
            </div>
          </div>
        </div>

        <!-- Switching spinner -->
        <div v-if="isSwitching" class="flex items-center gap-2 text-sm text-muted-foreground">
          <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Switching client...
        </div>

        <!-- Result -->
        <div v-if="switchResult" class="flex items-start gap-2 p-2 rounded-md text-sm" :class="switchResult.success ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-destructive/10 text-destructive'">
          <svg v-if="switchResult.success" class="w-4 h-4 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <svg v-else class="w-4 h-4 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span class="font-mono text-xs break-all">{{ switchResult.message }}</span>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
