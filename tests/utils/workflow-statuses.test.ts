import { describe, it, expect } from 'vitest'
import {
  computeWorkflowStatuses,
  computeActiveStatuses,
  computeInProgressKpiStatuses,
  computeFrozenKpiStatuses,
  computeDoneStatuses,
  REVIEW_CHAIN_STATUSES,
} from '~/utils/workflow-statuses'
import type { StatusMeta } from '~/composables/useStatuses'

function makeMeta(name: string, category: StatusMeta['category'], isBuiltIn = true): StatusMeta {
  return { name, label: name.toUpperCase(), category, isBuiltIn }
}

describe('computeWorkflowStatuses', () => {
  it('built-in mix → включает active+wip+frozen, исключает done', () => {
    const statuses: StatusMeta[] = [
      makeMeta('open', 'active'),
      makeMeta('in_progress', 'wip'),
      makeMeta('blocked', 'wip'),
      makeMeta('deferred', 'frozen'),
      makeMeta('pinned', 'frozen'),
      makeMeta('hooked', 'wip'),
      makeMeta('closed', 'done'),
    ]
    const result = computeWorkflowStatuses(statuses)
    expect(result).toEqual(['open', 'in_progress', 'blocked', 'deferred', 'pinned', 'hooked'])
    expect(result).not.toContain('closed')
  })

  it('кастомный inreview (category=wip) → присутствует в результате', () => {
    const statuses: StatusMeta[] = [
      makeMeta('open', 'active'),
      makeMeta('in_progress', 'wip'),
      makeMeta('closed', 'done'),
      makeMeta('inreview', 'wip', false),
    ]
    const result = computeWorkflowStatuses(statuses)
    expect(result).toContain('inreview')
    expect(result).not.toContain('closed')
  })

  it('дубликат имени → dedup (Set-семантика)', () => {
    const statuses: StatusMeta[] = [
      makeMeta('open', 'active'),
      makeMeta('open', 'active'),
      makeMeta('in_progress', 'wip'),
    ]
    const result = computeWorkflowStatuses(statuses)
    expect(result.filter(s => s === 'open')).toHaveLength(1)
  })

  it('пустой массив → []', () => {
    expect(computeWorkflowStatuses([])).toEqual([])
  })

  it('только done-статусы → []', () => {
    const statuses: StatusMeta[] = [
      makeMeta('closed', 'done'),
      makeMeta('archived', 'done', false),
    ]
    expect(computeWorkflowStatuses(statuses)).toEqual([])
  })
})

describe('computeActiveStatuses', () => {
  it('возвращает только active-статусы', () => {
    const statuses: StatusMeta[] = [
      makeMeta('open', 'active'),
      makeMeta('triage', 'active', false),
      makeMeta('in_progress', 'wip'),
      makeMeta('closed', 'done'),
    ]
    expect(computeActiveStatuses(statuses)).toEqual(['open', 'triage'])
  })

  it('исключает review-chain даже если category=active (defensive guard)', () => {
    const statuses: StatusMeta[] = [
      makeMeta('open', 'active'),
      makeMeta('inreview', 'active', false), // неожиданная категория
    ]
    expect(computeActiveStatuses(statuses)).toEqual(['open'])
    expect(computeActiveStatuses(statuses)).not.toContain('inreview')
  })

  it('исключает все 4 review-chain статуса из active', () => {
    const statuses: StatusMeta[] = REVIEW_CHAIN_STATUSES.map(name => makeMeta(name, 'active', false))
    expect(computeActiveStatuses(statuses)).toEqual([])
  })

  it('пустой массив → []', () => {
    expect(computeActiveStatuses([])).toEqual([])
  })
})

describe('computeInProgressKpiStatuses', () => {
  it('возвращает wip-статусы без blocked и без review-chain', () => {
    const statuses: StatusMeta[] = [
      makeMeta('in_progress', 'wip'),
      makeMeta('blocked', 'wip'),
      makeMeta('inreview', 'wip', false),
      makeMeta('peer_review', 'wip', false),
      makeMeta('open', 'active'),
      makeMeta('closed', 'done'),
    ]
    const result = computeInProgressKpiStatuses(statuses)
    expect(result).toContain('in_progress')
    expect(result).toContain('peer_review')
    expect(result).not.toContain('blocked')
    expect(result).not.toContain('inreview')
  })

  it('исключает все 4 review-chain статуса из inProgress', () => {
    const statuses: StatusMeta[] = [
      makeMeta('in_progress', 'wip'),
      ...REVIEW_CHAIN_STATUSES.map(name => makeMeta(name, 'wip', false)),
    ]
    const result = computeInProgressKpiStatuses(statuses)
    expect(result).toEqual(['in_progress'])
    for (const name of REVIEW_CHAIN_STATUSES) {
      expect(result).not.toContain(name)
    }
  })

  it('пустой массив → []', () => {
    expect(computeInProgressKpiStatuses([])).toEqual([])
  })
})

describe('computeFrozenKpiStatuses', () => {
  it('возвращает frozen-статусы без pinned', () => {
    const statuses: StatusMeta[] = [
      makeMeta('deferred', 'frozen'),
      makeMeta('on_hold', 'frozen', false),
      makeMeta('pinned', 'frozen'),
      makeMeta('open', 'active'),
    ]
    const result = computeFrozenKpiStatuses(statuses)
    expect(result).toContain('deferred')
    expect(result).toContain('on_hold')
    expect(result).not.toContain('pinned')
  })

  it('pinned исключён из frozen-set', () => {
    const statuses: StatusMeta[] = [makeMeta('pinned', 'frozen')]
    expect(computeFrozenKpiStatuses(statuses)).toEqual([])
  })

  it('пустой массив → []', () => {
    expect(computeFrozenKpiStatuses([])).toEqual([])
  })
})

describe('computeDoneStatuses', () => {
  it('возвращает все done-статусы', () => {
    const statuses: StatusMeta[] = [
      makeMeta('closed', 'done'),
      makeMeta('archived', 'done', false),
      makeMeta('open', 'active'),
    ]
    const result = computeDoneStatuses(statuses)
    expect(result).toEqual(['closed', 'archived'])
  })

  it('пустой массив → []', () => {
    expect(computeDoneStatuses([])).toEqual([])
  })
})
