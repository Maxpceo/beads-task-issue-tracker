import { describe, it, expect } from 'vitest'
import { computeWorkflowStatuses } from '~/utils/workflow-statuses'
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
