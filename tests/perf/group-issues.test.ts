import { describe, it, expect } from 'vitest'
import { groupIssues } from '~/utils/issue-helpers'
import { build500IssueFixture } from './issues-500-fixture'

// 100ms ≈ 4× observed CI mean (~15-25ms on ubuntu-22.04). Catches O(n²) regressions
// (which jump to 1000ms+) while absorbing shared-runner CPU variance.
const THRESHOLD_MS = 100
const ITERATIONS = 50

describe('groupIssues — perf regression gate', () => {
  it('groups 500 issues (50 epics × 10 children, 100-issue page) under threshold', () => {
    const fixture = build500IssueFixture()
    const paginated = fixture.slice(0, 100)

    for (let i = 0; i < 5; i++) groupIssues(paginated, fixture)

    const start = performance.now()
    for (let i = 0; i < ITERATIONS; i++) groupIssues(paginated, fixture)
    const meanMs = (performance.now() - start) / ITERATIONS

    expect(
      meanMs,
      `groupIssues mean ${meanMs.toFixed(2)}ms exceeded ${THRESHOLD_MS}ms — possible O(n²) regression`,
    ).toBeLessThan(THRESHOLD_MS)
  })
})
