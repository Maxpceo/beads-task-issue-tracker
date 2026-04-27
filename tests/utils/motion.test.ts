import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prefersReducedMotion, scrollBehavior } from '~/utils/motion'

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('prefersReducedMotion', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false when matchMedia reports no reduced-motion preference', () => {
    mockMatchMedia(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('returns true when matchMedia reports reduced-motion preference', () => {
    mockMatchMedia(true)
    expect(prefersReducedMotion()).toBe(true)
  })

  it('returns false when window.matchMedia is not available', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: undefined,
    })
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('scrollBehavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns "smooth" when reduced-motion is not preferred', () => {
    mockMatchMedia(false)
    expect(scrollBehavior()).toBe('smooth')
  })

  it('returns "auto" when reduced-motion is preferred', () => {
    mockMatchMedia(true)
    expect(scrollBehavior()).toBe('auto')
  })
})
