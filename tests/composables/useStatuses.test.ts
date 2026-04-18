import { describe, it, expect, vi, beforeAll } from 'vitest'

// useStatuses.ts использует module-level `reactive()` и `watch()` из Nuxt auto-imports.
// В тестовой среде auto-imports недоступны — мокаем зависимости до импорта модуля.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('~/utils/bd-api', () => ({
  logFrontend: vi.fn(() => Promise.resolve()),
}))

vi.mock('~/composables/useBeadsPath', () => ({
  useBeadsPath: () => ({
    beadsPath: { value: '/tmp/test-project' },
  }),
}))

describe('BUILTIN_FALLBACK categories guard', () => {
  let BUILTIN_FALLBACK: Array<{ name: string; category: string; isBuiltIn: boolean; label: string }>

  beforeAll(async () => {
    const mod = await import('~/composables/useStatuses')
    BUILTIN_FALLBACK = mod.BUILTIN_FALLBACK
  })

  it('содержит ровно 7 built-in статусов', () => {
    expect(BUILTIN_FALLBACK).toHaveLength(7)
  })

  it('все isBuiltIn = true', () => {
    expect(BUILTIN_FALLBACK.every(s => s.isBuiltIn)).toBe(true)
  })

  it('open → active', () => {
    const s = BUILTIN_FALLBACK.find(s => s.name === 'open')
    expect(s?.category).toBe('active')
  })

  it('in_progress → wip', () => {
    const s = BUILTIN_FALLBACK.find(s => s.name === 'in_progress')
    expect(s?.category).toBe('wip')
  })

  it('blocked → wip (не active)', () => {
    const s = BUILTIN_FALLBACK.find(s => s.name === 'blocked')
    expect(s?.category).toBe('wip')
  })

  it('deferred → frozen', () => {
    const s = BUILTIN_FALLBACK.find(s => s.name === 'deferred')
    expect(s?.category).toBe('frozen')
  })

  it('closed → done', () => {
    const s = BUILTIN_FALLBACK.find(s => s.name === 'closed')
    expect(s?.category).toBe('done')
  })

  it('pinned → frozen (не active)', () => {
    const s = BUILTIN_FALLBACK.find(s => s.name === 'pinned')
    expect(s?.category).toBe('frozen')
  })

  it('hooked → wip (не active)', () => {
    const s = BUILTIN_FALLBACK.find(s => s.name === 'hooked')
    expect(s?.category).toBe('wip')
  })
})
