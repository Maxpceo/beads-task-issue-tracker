import { describe, it, expect } from 'vitest'
import { BUILTIN_FALLBACK } from '~/composables/useStatuses'

/**
 * Guard-тест: категории BUILTIN_FALLBACK должны соответствовать `bd statuses`.
 * Тест ловит регрессии при изменении fallback.
 */
describe('BUILTIN_FALLBACK categories guard', () => {
  const categoryMap = Object.fromEntries(
    BUILTIN_FALLBACK.map(s => [s.name, s.category])
  )

  it('open → active', () => {
    expect(categoryMap['open']).toBe('active')
  })

  it('in_progress → wip', () => {
    expect(categoryMap['in_progress']).toBe('wip')
  })

  it('blocked → wip (не active)', () => {
    expect(categoryMap['blocked']).toBe('wip')
  })

  it('deferred → frozen', () => {
    expect(categoryMap['deferred']).toBe('frozen')
  })

  it('closed → done', () => {
    expect(categoryMap['closed']).toBe('done')
  })

  it('pinned → frozen (не active)', () => {
    expect(categoryMap['pinned']).toBe('frozen')
  })

  it('hooked → wip (не active)', () => {
    expect(categoryMap['hooked']).toBe('wip')
  })

  it('все 7 built-in статусов присутствуют', () => {
    const names = BUILTIN_FALLBACK.map(s => s.name)
    expect(names).toContain('open')
    expect(names).toContain('in_progress')
    expect(names).toContain('blocked')
    expect(names).toContain('closed')
    expect(names).toContain('deferred')
    expect(names).toContain('pinned')
    expect(names).toContain('hooked')
    expect(BUILTIN_FALLBACK).toHaveLength(7)
  })
})
