import type { Ref, ComputedRef } from 'vue'
import { ref, computed, watch } from 'vue'
import { projectUsesDolt, logFrontend } from '~/utils/bd-api'
import type { PollingProfile } from '~/composables/useAdaptivePolling'

export type ProjectSize = 'small' | 'medium' | 'large'

/**
 * Pure profile selection: (isDolt × size) → PollingProfile.
 *
 * Rules:
 * - non-Dolt (any size) → 'default'
 * - Dolt + small        → 'default'   (low volume — no benefit from longer intervals)
 * - Dolt + medium       → 'dolt-medium'
 * - Dolt + large        → 'dolt-large'
 *
 * Exported for unit testing without Vue reactivity.
 */
export function selectProfile(isDolt: boolean, size: ProjectSize): PollingProfile {
  if (!isDolt) return 'default'
  if (size === 'small') return 'default'
  if (size === 'medium') return 'dolt-medium'
  return 'dolt-large'
}

/**
 * Classifies project size by issue count.
 * - small:  < 200
 * - medium: 200 – 999
 * - large:  ≥ 1000
 */
export function classifySize(issueCount: number): ProjectSize {
  if (issueCount < 200) return 'small'
  if (issueCount < 1000) return 'medium'
  return 'large'
}

// Module-scope cache: cwd → isDolt, so we don't re-invoke on every reactive refresh.
const doltCache = new Map<string, boolean>()

/**
 * Composable that resolves the polling profile for the current project.
 *
 * @param cwd    - Reactive path to the project directory (null = no project selected).
 * @param issues - Reactive array used to derive project size from length.
 *
 * Returns:
 *   profile  — computed polling profile fed into useAdaptivePolling({ profile })
 *   isDolt   — whether the current project uses the Dolt backend
 *   size     — computed size classification
 */
export function useProjectProfile(
  cwd: Ref<string | null>,
  issues: Ref<Array<unknown>>,
): {
  profile: ComputedRef<PollingProfile>
  isDolt: Ref<boolean>
  size: ComputedRef<ProjectSize>
} {
  const isDolt = ref(false)

  // Resolve isDolt whenever cwd changes (with per-cwd cache)
  const resolveDolt = async (path: string | null) => {
    if (!path) {
      isDolt.value = false
      return
    }
    if (doltCache.has(path)) {
      isDolt.value = doltCache.get(path)!
      return
    }
    const result = await projectUsesDolt(path)
    doltCache.set(path, result)
    isDolt.value = result
    logFrontend('info', `[poll] project_uses_dolt cwd=${path} result=${result}`).catch(() => {})
  }

  watch(cwd, (newCwd) => { resolveDolt(newCwd) }, { immediate: true })

  const size = computed<ProjectSize>(() => classifySize(issues.value.length))

  const profile = computed<PollingProfile>(() => selectProfile(isDolt.value, size.value))

  // Log profile changes (side effect belongs in watch, not in computed)
  watch(profile, (p) => {
    logFrontend('info', `[poll] profile=${p} isDolt=${isDolt.value} size=${size.value} issueCount=${issues.value.length} interval=${p === 'dolt-large' ? 15000 : p === 'dolt-medium' ? 10000 : 5000}`).catch(() => {})
  }, { immediate: true })

  return { profile, isDolt, size }
}
