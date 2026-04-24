import { describe, it, expect } from 'vitest'
import { selectProfile, classifySize } from '~/composables/useProjectProfile'

describe('selectProfile', () => {
  it('returns default for non-Dolt project regardless of size', () => {
    expect(selectProfile(false, 'small')).toBe('default')
    expect(selectProfile(false, 'medium')).toBe('default')
    expect(selectProfile(false, 'large')).toBe('default')
  })

  it('returns default for Dolt + small (low volume, no benefit)', () => {
    expect(selectProfile(true, 'small')).toBe('default')
  })

  it('returns dolt-medium for Dolt + medium', () => {
    expect(selectProfile(true, 'medium')).toBe('dolt-medium')
  })

  it('returns dolt-large for Dolt + large', () => {
    expect(selectProfile(true, 'large')).toBe('dolt-large')
  })
})

describe('classifySize', () => {
  it('classifies 0 issues as small', () => {
    expect(classifySize(0)).toBe('small')
  })

  it('classifies < 200 as small', () => {
    expect(classifySize(199)).toBe('small')
  })

  it('classifies 200 as medium', () => {
    expect(classifySize(200)).toBe('medium')
  })

  it('classifies 999 as medium', () => {
    expect(classifySize(999)).toBe('medium')
  })

  it('classifies 1000 as large', () => {
    expect(classifySize(1000)).toBe('large')
  })

  it('classifies > 1000 as large', () => {
    expect(classifySize(5000)).toBe('large')
  })
})

describe('selectProfile edge cases', () => {
  it('isDolt=false, size=large → default (non-Dolt always default)', () => {
    expect(selectProfile(false, 'large')).toBe('default')
  })

  it('isDolt=true, size=small (issues.length=0 case) → default', () => {
    // Cold-start: no issues loaded yet → size=small → default
    expect(selectProfile(true, 'small')).toBe('default')
  })
})
