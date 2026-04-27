import type { Issue, DashboardStats } from '~/types/issue'
import { bdReady, logFrontend } from '~/utils/bd-api'
import { computeStatsFromIssues } from '~/utils/issue-helpers'
import { useStatuses } from '~/composables/useStatuses'

export function useDashboard() {
  const stats = ref<DashboardStats | null>(null)
  const readyIssues = ref<Issue[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const { beadsPath } = useBeadsPath()
  const { exclusions } = useExclusionFilters()
  const { statuses } = useStatuses()

  // Filter out issues with system-excluded labels before computing stats.
  // Only label-based exclusions apply — status/priority/type/assignee filters
  // are user-intent filters, not system-level visibility rules.
  const excludeSystemLabels = (issues: Issue[]): Issue[] => {
    if (exclusions.value.labels.length === 0) return issues
    return issues.filter(issue =>
      !issue.labels?.some(l => exclusions.value.labels.includes(l.toLowerCase())),
    )
  }

  // Helper to get the current path
  const getPath = () => beadsPath.value && beadsPath.value !== '.' ? beadsPath.value : undefined

  // Prefetch bdReady data — call this before fetchIssues to overlap the two API calls
  const prefetchReady = () => bdReady(getPath()).catch(() => [] as Issue[])

  // Fetch stats - now accepts issues to avoid extra API calls
  // Optional prefetchedReady: a Promise<Issue[]> from prefetchReady() already in flight
  const fetchStats = async (issues?: Issue[], prefetchedReady?: Promise<Issue[]>) => {
    isLoading.value = true
    error.value = null
    const pathAtStart = beadsPath.value

    try {
      // Preserve current ready count to avoid flash
      const currentReady = stats.value?.ready ?? 0

      // Compute stats from issues (even if empty array)
      stats.value = computeStatsFromIssues(excludeSystemLabels(issues ?? []), statuses.value)

      // Restore ready count while waiting for bdReady
      stats.value.ready = currentReady

      // Use prefetched ready data if available, otherwise fetch now
      const readyData = prefetchedReady
        ? await prefetchedReady
        : await bdReady(getPath())

      if (beadsPath.value !== pathAtStart) {
        logFrontend('debug', `[fetchStats] bail: path ${pathAtStart}→${beadsPath.value}`).catch(() => {})
        return
      }

      readyIssues.value = readyData || []

      // Update ready count in stats
      stats.value.ready = readyIssues.value.length
    } catch (e) {
      if (beadsPath.value !== pathAtStart) {
        const msg = e instanceof Error ? e.message : String(e)
        logFrontend('warn', `[fetchStats] suppressed stale-path error: ${msg} (was=${pathAtStart})`).catch(() => {})
        return
      }
      error.value = e instanceof Error ? e.message : 'Failed to fetch dashboard stats'
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Update dashboard from pre-fetched poll data (no API calls needed).
   * Used by the batched polling system to avoid separate bdReady call.
   */
  const updateFromPollData = (issues: Issue[], readyData: Issue[]) => {
    stats.value = computeStatsFromIssues(excludeSystemLabels(issues), statuses.value)
    readyIssues.value = readyData || []
    stats.value.ready = readyIssues.value.length
  }

  // Clear all stats data (used when removing last favorite)
  const clearStats = () => {
    stats.value = null
    readyIssues.value = []
    error.value = null
  }

  return {
    stats,
    readyIssues,
    isLoading,
    error,
    prefetchReady,
    fetchStats,
    computeStatsFromIssues,
    updateFromPollData,
    clearStats,
  }
}
