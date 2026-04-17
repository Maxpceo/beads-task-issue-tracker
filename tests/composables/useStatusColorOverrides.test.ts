import { describe, it, expect, beforeEach } from 'vitest'

// Test the ColorOverride type shape and the logic for style computation
// (the composable delegates persistence to useProjectStorage which is tested separately)

describe('ColorOverride style computation', () => {
  // Mirror the logic from StatusBadge.vue config computed
  function computeStyle(override: { from: string; to?: string } | undefined) {
    if (!override) return undefined
    return override.to
      ? `linear-gradient(135deg, ${override.from}, ${override.to})`
      : override.from
  }

  it('returns undefined when no override', () => {
    expect(computeStyle(undefined)).toBeUndefined()
  })

  it('returns solid color for single-color override', () => {
    expect(computeStyle({ from: '#ff00ff' })).toBe('#ff00ff')
  })

  it('returns gradient when to is present', () => {
    expect(computeStyle({ from: '#ff0000', to: '#0000ff' })).toBe(
      'linear-gradient(135deg, #ff0000, #0000ff)'
    )
  })

  it('solid override ignores undefined to', () => {
    expect(computeStyle({ from: '#123456', to: undefined })).toBe('#123456')
  })
})

describe('ColorOverride store operations (localStorage mock)', () => {
  // Simple in-memory store to test set/get/remove logic
  let store: Record<string, { from: string; to?: string }> = {}

  function getOverride(name: string) {
    return store[name]
  }
  function setOverride(name: string, override: { from: string; to?: string }) {
    store = { ...store, [name]: override }
  }
  function removeOverride(name: string) {
    const next = { ...store }
    delete next[name]
    store = next
  }

  beforeEach(() => {
    store = {}
  })

  it('getOverride returns undefined for unknown status', () => {
    expect(getOverride('open')).toBeUndefined()
  })

  it('setOverride stores an override', () => {
    setOverride('open', { from: '#ff0000' })
    expect(getOverride('open')).toEqual({ from: '#ff0000' })
  })

  it('setOverride with gradient stores both colors', () => {
    setOverride('inreview', { from: '#ff0000', to: '#00ff00' })
    expect(getOverride('inreview')).toEqual({ from: '#ff0000', to: '#00ff00' })
  })

  it('removeOverride clears an override', () => {
    setOverride('open', { from: '#ff0000' })
    removeOverride('open')
    expect(getOverride('open')).toBeUndefined()
  })

  it('removeOverride on non-existent key is safe', () => {
    expect(() => removeOverride('nonexistent')).not.toThrow()
  })

  it('setOverride preserves other overrides', () => {
    setOverride('open', { from: '#ff0000' })
    setOverride('closed', { from: '#00ff00' })
    removeOverride('open')
    expect(getOverride('closed')).toEqual({ from: '#00ff00' })
    expect(getOverride('open')).toBeUndefined()
  })

  it('overwriting an override replaces it', () => {
    setOverride('open', { from: '#ff0000', to: '#0000ff' })
    setOverride('open', { from: '#123456' })
    expect(getOverride('open')).toEqual({ from: '#123456' })
  })
})
