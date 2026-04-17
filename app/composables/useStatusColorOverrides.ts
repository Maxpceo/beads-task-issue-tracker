import { logFrontend } from '~/utils/bd-api'
import { useProjectStorage } from '~/composables/useProjectStorage'

export interface ColorOverride {
  from: string
  to?: string
}

// Module-level store — shared across all composable instances
let store: Ref<Record<string, ColorOverride>> | null = null

export function useStatusColorOverrides(): {
  getOverride: (name: string) => ColorOverride | undefined
  setOverride: (name: string, override: ColorOverride) => void
  removeOverride: (name: string) => void
} {
  if (!store) {
    store = useProjectStorage<Record<string, ColorOverride>>('status-colors', {})
  }

  function getOverride(name: string): ColorOverride | undefined {
    return store!.value[name]
  }

  function setOverride(name: string, override: ColorOverride): void {
    store!.value = { ...store!.value, [name]: override }
    logFrontend('debug', `[useStatusColorOverrides] setOverride: ${name} = ${JSON.stringify(override)}`).catch(() => {})
  }

  function removeOverride(name: string): void {
    const next = { ...store!.value }
    delete next[name]
    store!.value = next
    logFrontend('debug', `[useStatusColorOverrides] removeOverride: ${name}`).catch(() => {})
  }

  return { getOverride, setOverride, removeOverride }
}
