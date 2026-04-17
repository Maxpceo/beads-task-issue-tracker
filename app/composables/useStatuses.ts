import { invoke } from '@tauri-apps/api/core'
import { logFrontend } from '~/utils/bd-api'
import { useBeadsPath } from '~/composables/useBeadsPath'

export interface StatusMeta {
  name: string
  label: string
  category: 'active' | 'wip' | 'frozen' | 'done'
  icon?: string
  isBuiltIn: boolean
}

interface BdStatusEntry {
  name: string
  category: string
  icon?: string
  description?: string
}

interface BdStatusesResponse {
  built_in_statuses: BdStatusEntry[]
  custom_statuses: BdStatusEntry[]
}

// Module-level reactive cache — keyed by project path
const cacheByPath = reactive(new Map<string, StatusMeta[]>())
const loadingPaths = new Set<string>()

function makeLabel(name: string): string {
  return name.toUpperCase().replace(/_/g, ' ')
}

function toStatusMeta(entry: BdStatusEntry, isBuiltIn: boolean): StatusMeta {
  const category = (['active', 'wip', 'frozen', 'done'].includes(entry.category)
    ? entry.category
    : 'active') as StatusMeta['category']
  return {
    name: entry.name,
    label: makeLabel(entry.name),
    category,
    icon: entry.icon || undefined,
    isBuiltIn,
  }
}

// Built-in fallback used when the Tauri command is unavailable
const BUILTIN_FALLBACK: StatusMeta[] = [
  { name: 'open', label: 'OPEN', category: 'active', isBuiltIn: true },
  { name: 'in_progress', label: 'IN PROGRESS', category: 'wip', isBuiltIn: true },
  { name: 'blocked', label: 'BLOCKED', category: 'active', isBuiltIn: true },
  { name: 'closed', label: 'CLOSED', category: 'done', isBuiltIn: true },
  { name: 'deferred', label: 'DEFERRED', category: 'frozen', isBuiltIn: true },
  { name: 'pinned', label: 'PINNED', category: 'active', isBuiltIn: true },
  { name: 'hooked', label: 'HOOKED', category: 'active', isBuiltIn: true },
]

async function loadForPath(path: string): Promise<void> {
  if (cacheByPath.has(path) || loadingPaths.has(path)) return
  loadingPaths.add(path)
  try {
    const response = await invoke<BdStatusesResponse>('bd_statuses', { options: { cwd: path } })
    const built = response.built_in_statuses.map((s) => toStatusMeta(s, true))
    const custom = response.custom_statuses.map((s) => toStatusMeta(s, false))
    cacheByPath.set(path, [...built, ...custom])
    logFrontend(
      'info',
      `[useStatuses] Loaded ${built.length} built-in + ${custom.length} custom statuses for ${path}`
    ).catch(() => {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logFrontend('warn', `[useStatuses] Failed to load statuses for ${path}: ${msg}`).catch(() => {})
    // Fall back to built-ins so badges don't break
    cacheByPath.set(path, [...BUILTIN_FALLBACK])
  } finally {
    loadingPaths.delete(path)
  }
}

export function useStatuses() {
  const { beadsPath } = useBeadsPath()

  const statuses = computed<StatusMeta[]>(() => {
    return cacheByPath.get(beadsPath.value) ?? []
  })

  const getMeta = (name: string): StatusMeta | undefined => {
    return statuses.value.find((s) => s.name === name)
  }

  const refresh = async (): Promise<void> => {
    cacheByPath.delete(beadsPath.value)
    await loadForPath(beadsPath.value)
  }

  // Kick off lazy load on mount and whenever the path changes
  if (import.meta.client) {
    watch(
      beadsPath,
      (path) => {
        loadForPath(path)
      },
      { immediate: true }
    )
  }

  return {
    statuses,
    getMeta,
    refresh,
  }
}
