import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../app/assets/css/tailwind.css'), 'utf-8')

describe('reduced-motion CSS regression guard', () => {
  it('has @media (prefers-reduced-motion: reduce) block', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('collapses transition-duration to near-zero in global block', () => {
    expect(css).toContain('transition-duration: 0.01ms !important')
  })

  it('has .animate-spin spinner exception that keeps animation infinite', () => {
    expect(css).toContain('animation-iteration-count: infinite !important')
    expect(css).toContain('.animate-spin')
  })
})
