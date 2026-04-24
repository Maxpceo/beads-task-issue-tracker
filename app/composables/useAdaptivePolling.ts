import { useWindowFocus, useIdle } from '@vueuse/core'

/**
 * Adaptive polling composable that adjusts poll interval based on window state.
 *
 * | State                    | Poll     | Check    | Rationale                              |
 * |--------------------------|----------|----------|----------------------------------------|
 * | Focused + active         | 5s       | 1s       | Fast mtime detection + periodic poll   |
 * | Focused + watcher active | 30s      | —        | Watcher handles detection, safety net  |
 * | Window blurred           | 30s      | —        | Visible on another monitor, not focused|
 * | Idle (2min no input)     | 60s      | —        | User away or just reading              |
 * | Hidden/minimized         | Paused   | —        | No point polling if not visible        |
 *
 * When a `checkFn` is provided, it runs on a fast 1s interval (active state only).
 * When `checkFn` returns true, `pollFn` is called immediately — no waiting for the
 * next poll cycle. This decouples cheap mtime detection from expensive data fetching.
 *
 * Optionally accepts a `profile` ref that selects a profile-based interval table,
 * allowing Dolt-large projects to use longer intervals and reduce CPU load.
 */

export type PollingProfile = 'default' | 'dolt-medium' | 'dolt-large'

/**
 * Profile-based interval table (ms).
 * INTERVAL_CHECK (fast 1s mtime check) is NOT profile-dependent — it remains cheap.
 *
 * | Profile      | Active | Watcher-safety | Blurred | Idle   |
 * |-------------|-------:|---------------:|--------:|-------:|
 * | default      |  5 000 |         30 000 |  30 000 | 60 000 |
 * | dolt-medium  | 10 000 |         45 000 |  60 000 |120 000 |
 * | dolt-large   | 15 000 |         60 000 |  90 000 |180 000 |
 */
export const INTERVAL_TABLE: Record<PollingProfile, { active: number; watcherSafety: number; blurred: number; idle: number }> = {
  'default':     { active:  5_000, watcherSafety: 30_000, blurred: 30_000, idle:  60_000 },
  'dolt-medium': { active: 10_000, watcherSafety: 45_000, blurred: 60_000, idle: 120_000 },
  'dolt-large':  { active: 15_000, watcherSafety: 60_000, blurred: 90_000, idle: 180_000 },
}

const INTERVAL_CHECK = 1_000         // 1 second — fast mtime check (active only, never profile-gated)
const IDLE_TIMEOUT = 120_000         // 2 minutes

interface AdaptivePollingOptions {
  /** Cheap check function (e.g., mtime stat). Returns true if pollFn should run. */
  checkFn?: () => Promise<boolean>
  /** Interval for checkFn in ms (default: 1000). Only used when window is focused + active. */
  checkInterval?: number
  /** When true, disables 1s mtime check loop and uses 30s safety-net interval instead. */
  watcherActive?: Ref<boolean>
  /**
   * Project profile that selects the interval row from INTERVAL_TABLE.
   * Defaults to 'default' if not provided (backward-compatible).
   */
  profile?: Ref<PollingProfile>
}

export function useAdaptivePolling(pollFn: () => Promise<void>, options?: AdaptivePollingOptions) {
  const isFocused = useWindowFocus()
  const { idle } = useIdle(IDLE_TIMEOUT)

  let timer: ReturnType<typeof setTimeout> | null = null
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let polling = false // guard against concurrent polls

  // Track hidden state to detect return from minimized
  let wasHidden = false

  const checkInterval = options?.checkInterval ?? INTERVAL_CHECK

  const currentInterval = computed(() => {
    if (typeof document !== 'undefined' && document.hidden) return 0 // paused
    const row = INTERVAL_TABLE[options?.profile?.value ?? 'default']
    if (idle.value) return row.idle
    if (!isFocused.value) return row.blurred
    // When watcher is active, use longer safety-net interval (watcher handles detection)
    if (options?.watcherActive?.value) return row.watcherSafety
    return row.active
  })

  const isActive = () => currentInterval.value === (INTERVAL_TABLE[options?.profile?.value ?? 'default'].active)

  const runPoll = async () => {
    if (polling) return
    polling = true
    try {
      await pollFn()
    } catch {
      // Ignore poll errors
    } finally {
      polling = false
    }
  }

  // --- Fast change detection loop (only when active and no watcher) ---
  const scheduleCheck = () => {
    if (!running || !options?.checkFn) return
    if (checkTimer) clearTimeout(checkTimer)

    // Skip fast mtime check when watcher is active (watcher handles detection)
    if (options?.watcherActive?.value) return

    // Only run fast check when window is focused + active
    if (!isActive()) return

    checkTimer = setTimeout(async () => {
      if (!running || !isActive()) {
        scheduleCheck()
        return
      }
      try {
        const changed = await options.checkFn!()
        if (changed && running) {
          // Change detected — cancel pending poll timer and run immediately
          if (timer) { clearTimeout(timer); timer = null }
          await runPoll()
          scheduleNext() // Reset regular poll timer after immediate poll
        }
      } catch {
        // Ignore check errors
      }
      scheduleCheck()
    }, checkInterval)
  }

  const clearCheckTimer = () => {
    if (checkTimer) {
      clearTimeout(checkTimer)
      checkTimer = null
    }
  }

  // --- Regular poll timer (adaptive interval) ---
  const scheduleNext = () => {
    if (!running) return
    if (timer) clearTimeout(timer)

    const interval = currentInterval.value
    if (interval === 0) {
      // Paused — don't schedule, visibility handler will resume
      return
    }

    timer = setTimeout(async () => {
      if (!running) return
      await runPoll()
      scheduleNext()
    }, interval)
  }

  const handleVisibilityChange = () => {
    if (!running) return

    if (document.hidden) {
      // Going hidden — clear both timers
      wasHidden = true
      if (timer) { clearTimeout(timer); timer = null }
      clearCheckTimer()
    } else if (wasHidden) {
      // Returning from hidden — immediate poll + resume both loops
      wasHidden = false
      runPoll().finally(() => {
        scheduleNext()
        scheduleCheck()
      })
    }
  }

  // Watch focus transitions: poll immediately when returning from blurred
  watch(isFocused, (focused, wasFocused) => {
    if (!running) return
    if (focused && wasFocused === false) {
      // Window just gained focus — immediate poll + reschedule + start fast check
      runPoll().finally(() => {
        scheduleNext()
        scheduleCheck()
      })
    } else if (!focused) {
      // Blurred — stop fast check, reschedule poll with blurred interval
      clearCheckTimer()
      scheduleNext()
    }
  })

  // Watch profile/interval transitions: reschedule timer immediately when profile flips
  // (e.g., project crosses 200-issue threshold from small → medium). Without this, the
  // active timer would keep running with the old interval until it next fires.
  watch(currentInterval, () => {
    if (!running) return
    if (typeof document !== 'undefined' && document.hidden) return
    scheduleNext()
  })

  // Watch idle transitions: reschedule when idle state changes
  watch(idle, (isIdle, wasIdlePrev) => {
    if (!running) return
    if (!isIdle && wasIdlePrev) {
      // User returned from idle — immediate poll + reschedule + start fast check
      runPoll().finally(() => {
        scheduleNext()
        scheduleCheck()
      })
    } else if (isIdle) {
      // User went idle — stop fast check, reschedule with idle interval
      clearCheckTimer()
      scheduleNext()
    }
  })

  const start = () => {
    if (running) return
    running = true
    wasHidden = false

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    scheduleNext()
    scheduleCheck() // Start fast check loop if checkFn provided
  }

  const stop = () => {
    running = false
    if (timer) { clearTimeout(timer); timer = null }
    clearCheckTimer()

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }

  return {
    start,
    stop,
    currentInterval,
  }
}
