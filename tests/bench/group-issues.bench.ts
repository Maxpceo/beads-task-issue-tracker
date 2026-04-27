/**
 * Performance benchmark: groupIssues on a 500-issue fixture (50 epics × 10 children).
 *
 * Threshold strategy: hard upper bound via tinybench teardown hook — 50ms mean
 * (≈ 2× observed CI mean on ubuntu-22.04; M1 local mean is ~0.4ms).
 * If groupIssues regresses to O(n²), mean will exceed 50ms and the teardown assertion fails.
 *
 * Note: `vitest bench` experimental feature — pin vitest version in production use.
 */
import { bench, describe, expect } from 'vitest'
import type { Task } from 'tinybench'
import { groupIssues } from '~/utils/issue-helpers'
import { build500IssueFixture } from './fixtures/issues-500'

// Build fixture once — deterministic (no Math.random), stable across runs
const fixture = build500IssueFixture()

// Threshold: 50ms mean — ~2× observed ubuntu-22.04 CI mean (~15–25ms).
// On M1 Mac, mean is ~0.4ms. Threshold gives ~100× headroom locally, ~2–3× on CI.
const THRESHOLD_MS = 50

describe('groupIssues — 500 issues', () => {
  bench(
    'group 500 issues (50 epics × 10 children)',
    () => {
      groupIssues(fixture, fixture)
    },
    {
      time: 1000,
      iterations: 50,
      teardown(task: Task, mode: 'warmup' | 'run') {
        // Only assert during the actual run (not warmup)
        if (mode !== 'run') return
        const mean = task.result?.mean ?? 0
        expect(
          mean,
          `groupIssues mean ${mean.toFixed(2)}ms exceeded ${THRESHOLD_MS}ms — possible O(n²) regression`,
        ).toBeLessThan(THRESHOLD_MS)
      },
    },
  )
})
