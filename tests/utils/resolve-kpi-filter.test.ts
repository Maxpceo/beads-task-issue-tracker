import { describe, it, expect } from 'vitest'
import { resolveKpiFilter, type KpiResolverInputs } from '~/utils/issue-helpers'
import type { IssueStatus } from '~/types/issue'

const workflowStatuses: IssueStatus[] = ['open', 'in_progress', 'blocked', 'deferred']
const allStatuses: IssueStatus[] = ['open', 'in_progress', 'blocked', 'deferred', 'closed']

const sets = {
  open: ['open'] as IssueStatus[],
  inProgress: ['in_progress'] as IssueStatus[],
  frozen: ['deferred'] as IssueStatus[],
  done: ['closed'] as IssueStatus[],
}

function make(selected: IssueStatus[], overrides: Partial<KpiResolverInputs> = {}): KpiResolverInputs {
  return {
    selected,
    workflowStatuses,
    allStatuses,
    sets,
    ...overrides,
  }
}

describe('resolveKpiFilter', () => {
  it('sel=[] → workflow', () => {
    expect(resolveKpiFilter(make([]))).toBe('workflow')
  })

  it('sel=workflowStatuses → workflow', () => {
    expect(resolveKpiFilter(make([...workflowStatuses]))).toBe('workflow')
  })

  it('sel=allStatuses → total', () => {
    expect(resolveKpiFilter(make([...allStatuses]))).toBe('total')
  })

  it('sel=done set (closed) → done', () => {
    expect(resolveKpiFilter(make(['closed']))).toBe('done')
  })

  it('sel=open set (open) → open', () => {
    expect(resolveKpiFilter(make(['open']))).toBe('open')
  })

  it('sel=custom open set (open+triage) → open when sets.open matches', () => {
    const customSets = { ...sets, open: ['open', 'triage'] as IssueStatus[] }
    expect(resolveKpiFilter(make(['open', 'triage'], { sets: customSets }))).toBe('open')
  })

  it('sel=[open] при sets.open=[open,triage] → null (strict equality policy)', () => {
    const customSets = { ...sets, open: ['open', 'triage'] as IssueStatus[] }
    expect(resolveKpiFilter(make(['open'], { sets: customSets }))).toBeNull()
  })

  it('sel=[blocked] → blocked', () => {
    expect(resolveKpiFilter(make(['blocked']))).toBe('blocked')
  })

  it('sel=REVIEW_CHAIN_STATUSES → in_review', () => {
    const reviewStatuses = ['inreview', 'simplified', 'reviewed', 'accepted'] as IssueStatus[]
    expect(resolveKpiFilter(make(reviewStatuses))).toBe('in_review')
  })

  it('sel=[random_unknown] → null', () => {
    expect(resolveKpiFilter(make(['tombstone' as IssueStatus]))).toBeNull()
  })

  it('sel=inProgress set → in_progress', () => {
    expect(resolveKpiFilter(make(['in_progress']))).toBe('in_progress')
  })

  it('sel=frozen set → deferred', () => {
    expect(resolveKpiFilter(make(['deferred']))).toBe('deferred')
  })
})
