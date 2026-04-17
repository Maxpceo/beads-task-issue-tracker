import { type ComputedRef } from 'vue'
import { logFrontend } from '~/utils/bd-api'
import { useProjectStorage } from '~/composables/useProjectStorage'

export interface ColorOverride {
  from: string
  to?: string
}

// Module-level store — shared across all composable instances
let store: Ref<Record<string, ColorOverride>> | null = null

function getStore(): Ref<Record<string, ColorOverride>> {
  if (!store) {
    store = useProjectStorage<Record<string, ColorOverride>>('status-colors', {})
  }
  return store
}

export function useStatusColorOverrides(): {
  overrides: ComputedRef<Record<string, ColorOverride>>
  getOverride: (name: string) => ColorOverride | undefined
  setOverride: (name: string, override: ColorOverride) => void
  removeOverride: (name: string) => void
} {
  const store = getStore()

  const overrides = computed<Record<string, ColorOverride>>(() => store.value)

  function getOverride(name: string): ColorOverride | undefined {
    return store.value[name]
  }

  function setOverride(name: string, override: ColorOverride): void {
    store.value = { ...store.value, [name]: override }
    logFrontend('debug', `[useStatusColorOverrides] setOverride: ${name} = ${JSON.stringify(override)}`).catch(() => {})
  }

  function removeOverride(name: string): void {
    const next = { ...store.value }
    delete next[name]
    store.value = next
    logFrontend('debug', `[useStatusColorOverrides] removeOverride: ${name}`).catch(() => {})
  }

  return { overrides, getOverride, setOverride, removeOverride }
}
