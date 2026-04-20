import { ref, computed, watch } from 'vue'
import type { Issue } from '~/types/issue'
import { bdList, logFrontend } from '~/utils/bd-api'
import { matchesSearch } from '~/utils/issue-helpers'
import { useFavorites } from '~/composables/useFavorites'

export interface PaletteResult {
  issue: Issue
  projectPath: string
  projectName: string
  rank: number
}

/**
 * Determine the display name for a project, disambiguating duplicate last-segments
 * by prepending the parent directory segment.
 */
function buildProjectNames(projectPaths: string[]): Map<string, string> {
  const lastSegments = projectPaths.map(p => p.replace(/\/+$/, '').split('/').pop() ?? p)
  const counts = new Map<string, number>()
  for (const seg of lastSegments) {
    counts.set(seg, (counts.get(seg) ?? 0) + 1)
  }

  const result = new Map<string, string>()
  for (const path of projectPaths) {
    const parts = path.replace(/\/+$/, '').split('/')
    const last = parts.pop() ?? path
    if ((counts.get(last) ?? 0) > 1) {
      const parent = parts.pop() ?? ''
      result.set(path, parent ? `${parent}/${last}` : last)
    } else {
      result.set(path, last)
    }
  }
  return result
}

/**
 * Compute a rank bucket for sorting palette results (lower = higher priority).
 * Ranking:
 *  1 - id exact match
 *  2 - last-segment id match (e.g. "nif" matches "beads-task-issue-tracker-nif")
 *  3 - id contains
 *  4 - title exact match (case-insensitive)
 *  5 - title contains
 *  6 - other fields contain
 */
function computeRank(issue: Issue, term: string): number {
  const id = issue.id.toLowerCase()
  const title = issue.title.toLowerCase()
  const lastSegment = id.split('-').pop() ?? ''

  if (id === term) return 1
  if (lastSegment === term) return 2
  if (id.includes(term)) return 3
  if (title === term) return 4
  if (title.includes(term)) return 5
  return 6
}

// Shared singleton state
const open = ref(false)
const query = ref('')
const loading = ref(false)
const errors = ref<string[]>([])
const focusedIndex = ref(0)
const allResults = ref<PaletteResult[]>([])
let lastRefreshAt = 0

watch(query, () => { focusedIndex.value = 0 })

const results = computed<PaletteResult[]>(() => {
  const term = query.value.toLowerCase().trim()
  if (!term) return []

  const matched = allResults.value
    .filter(r => matchesSearch(r.issue, term))
    .map(r => ({ ...r, rank: computeRank(r.issue, term) }))

  // Sort by rank, then by updatedAt desc within same rank
  matched.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    return b.issue.updatedAt.localeCompare(a.issue.updatedAt)
  })

  return matched.slice(0, 50)
})

async function refresh() {
  const { projects } = useFavorites()
  const snap = [...projects.value]

  if (snap.length === 0) {
    allResults.value = []
    lastRefreshAt = Date.now()
    return
  }

  loading.value = true
  errors.value = []
  const t0 = performance.now()

  const projectNames = buildProjectNames(snap.map(p => p.path))

  const settled = await Promise.allSettled(
    snap.map(p => bdList({ path: p.path, includeAll: true }))
  )

  const flat: PaletteResult[] = []
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!
    const proj = snap[i]!
    if (result.status === 'fulfilled') {
      for (const issue of result.value) {
        flat.push({
          issue,
          projectPath: proj.path,
          projectName: projectNames.get(proj.path) ?? proj.path,
          rank: 0,
        })
      }
    } else {
      const err = result.reason instanceof Error ? result.reason.message : String(result.reason)
      errors.value.push(proj.path)
      logFrontend('warn', `[useCommandPalette] fetch failed for ${proj.path}: ${err}`).catch(() => {})
    }
  }

  allResults.value = flat
  lastRefreshAt = Date.now()
  loading.value = false

  const elapsed = (performance.now() - t0).toFixed(0)
  logFrontend('debug', `[useCommandPalette] fan-out ${elapsed}ms for ${snap.length} projects`).catch(() => {})
}

function openPalette() {
  open.value = true
  const ttlExpired = Date.now() - lastRefreshAt > 30_000
  if (ttlExpired) {
    refresh()
  }
}

function closePalette() {
  open.value = false
  query.value = ''
  focusedIndex.value = 0
}

function onArrowDown() {
  if (results.value.length === 0) return
  focusedIndex.value = (focusedIndex.value + 1) % results.value.length
}

function onArrowUp() {
  if (results.value.length === 0) return
  focusedIndex.value = (focusedIndex.value - 1 + results.value.length) % results.value.length
}

export function useCommandPalette() {
  return {
    open,
    query,
    loading,
    errors,
    focusedIndex,
    results,
    allResults,
    openPalette,
    closePalette,
    onArrowDown,
    onArrowUp,
    refresh,
  }
}
