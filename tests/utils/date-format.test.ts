import { describe, it, expect } from 'vitest'
import { formatDate, formatTime } from '~/utils/date-format'

describe('formatDate', () => {
  it('formats valid date string in EN locale (contains year and month name)', () => {
    const result = formatDate('2026-04-19', 'en')
    expect(result).toContain('2026')
    expect(result).toContain('April')
  })

  it('formats valid date string in RU locale (contains year and Russian month)', () => {
    const result = formatDate('2026-04-19', 'ru')
    expect(result).toContain('2026')
    expect(result).toContain('апреля')
  })

  it('returns "-" for null input', () => {
    expect(formatDate(null)).toBe('-')
  })

  it('returns "-" for undefined input', () => {
    expect(formatDate(undefined)).toBe('-')
  })

  it('returns "-" for invalid date string', () => {
    expect(formatDate('not-a-date')).toBe('-')
  })

  it('accepts a Date object', () => {
    const result = formatDate(new Date('2026-04-19'), 'en')
    expect(result).toContain('2026')
    expect(result).toContain('April')
  })

  it('defaults to EN locale when no second argument is provided', () => {
    const result = formatDate('2026-04-19')
    // EN locale should produce month name in English
    expect(result).toContain('April')
    expect(result).toContain('2026')
  })
})

describe('formatTime', () => {
  it('returns a string containing ":" for a valid ISO date string', () => {
    const result = formatTime('2026-04-19T06:48:00Z', 'en')
    expect(result).toContain(':')
  })

  it('EN locale uses AM/PM format (12-hour)', () => {
    // 06:48 UTC — EN-US uses AM/PM
    const result = formatTime('2026-04-19T06:48:00Z', 'en')
    // Should contain AM or PM marker (locale-aware)
    expect(result.toLowerCase()).toMatch(/am|pm/)
  })

  it('RU locale uses 24-hour format (no AM/PM)', () => {
    const result = formatTime('2026-04-19T06:48:00Z', 'ru')
    // Russian locale does not use AM/PM
    expect(result.toLowerCase()).not.toMatch(/am|pm/)
    expect(result).toContain(':')
  })

  it('returns "" for null input', () => {
    expect(formatTime(null)).toBe('')
  })

  it('returns "" for undefined input', () => {
    expect(formatTime(undefined)).toBe('')
  })

  it('returns "" for invalid date string', () => {
    expect(formatTime('not-a-date')).toBe('')
  })

  it('accepts a Date object', () => {
    const result = formatTime(new Date('2026-04-19T14:30:00Z'), 'en')
    expect(result).toContain(':')
  })

  it('defaults to EN locale when no second argument is provided', () => {
    const result = formatTime('2026-04-19T06:48:00Z')
    expect(result.toLowerCase()).toMatch(/am|pm/)
  })
})
