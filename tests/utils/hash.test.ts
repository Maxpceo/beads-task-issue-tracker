import { describe, it, expect } from 'vitest'
import { hashPath } from '~/utils/hash'

describe('hashPath', () => {
  it('returns an 8-character hex string', () => {
    const result = hashPath('/home/dev/project')
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is deterministic (same input → same output)', () => {
    expect(hashPath('/home/dev/project')).toBe(hashPath('/home/dev/project'))
  })

  it('produces different hashes for different paths', () => {
    const a = hashPath('/home/dev/project-a')
    const b = hashPath('/home/dev/project-b')
    expect(a).not.toBe(b)
  })

  it('handles empty string', () => {
    const result = hashPath('')
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  it('handles long paths', () => {
    const long = '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z'
    const result = hashPath(long)
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  it('handles special characters', () => {
    const result = hashPath('/home/dev/my project (2)')
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  // Cross-language parity: these exact hex values MUST match the Rust
  // `hash_path_djb2` output in `src-tauri/src/lib.rs`. If you change the
  // hash algorithm on one side, update the other and regenerate these.
  // Verified 2026-04 via `node /tmp/hash-compute.mjs` vs `rustc ... && ./bin`.
  describe('JS↔Rust parity (fixed expected values)', () => {
    it('ASCII path', () => {
      expect(hashPath('/home/dev/project')).toBe('37a0a871')
    })

    it('Cyrillic path (directory name)', () => {
      expect(hashPath('/Users/максим/project')).toBe('26b3ca76')
    })

    it('Cyrillic path (trailing segment)', () => {
      expect(hashPath('/Users/dev/проект')).toBe('319ee14f')
    })

    it('emoji / astral (surrogate pair) path', () => {
      expect(hashPath('/tmp/🚀/repo')).toBe('54a05b76')
    })

    it('empty string → djb2 seed 5381 = 0x1505', () => {
      expect(hashPath('')).toBe('00001505')
    })
  })
})
