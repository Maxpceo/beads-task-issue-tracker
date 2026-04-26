import { describe, it, expect } from 'vitest'
import { russianPluralRule } from '~/utils/plural-rules'

describe('russianPluralRule (CLDR ru)', () => {
  describe('3-form mode (choicesLength=3): [one=0, few=1, many=2]', () => {
    const rule = (n: number) => russianPluralRule(n, 3)

    it('one → index 0: 1, 21, 31, 101', () => {
      expect(rule(1)).toBe(0)
      expect(rule(21)).toBe(0)
      expect(rule(31)).toBe(0)
      expect(rule(101)).toBe(0)
    })

    it('few → index 1: 2, 3, 4, 22, 23, 24, 102, 103, 104', () => {
      expect(rule(2)).toBe(1)
      expect(rule(3)).toBe(1)
      expect(rule(4)).toBe(1)
      expect(rule(22)).toBe(1)
      expect(rule(23)).toBe(1)
      expect(rule(24)).toBe(1)
      expect(rule(102)).toBe(1)
      expect(rule(103)).toBe(1)
      expect(rule(104)).toBe(1)
    })

    it('many → index 2: 0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 25, 100, 111, 112, 114', () => {
      expect(rule(0)).toBe(2)
      expect(rule(5)).toBe(2)
      expect(rule(6)).toBe(2)
      expect(rule(9)).toBe(2)
      expect(rule(10)).toBe(2)
      expect(rule(11)).toBe(2)
      expect(rule(12)).toBe(2)
      expect(rule(13)).toBe(2)
      expect(rule(14)).toBe(2)
      expect(rule(15)).toBe(2)
      expect(rule(20)).toBe(2)
      expect(rule(25)).toBe(2)
      expect(rule(100)).toBe(2)
      expect(rule(111)).toBe(2)
      expect(rule(112)).toBe(2)
      expect(rule(114)).toBe(2)
    })

    it('teens 11-14 always many despite mod10', () => {
      // 11: mod10=1 but mod100=11 → many
      expect(rule(11)).toBe(2)
      // 12: mod10=2 but mod100=12 → many
      expect(rule(12)).toBe(2)
      // 14: mod10=4 but mod100=14 → many
      expect(rule(14)).toBe(2)
    })
  })

  describe('4-form mode (choicesLength=4): [zero=0, one=1, few=2, many=3]', () => {
    const rule = (n: number) => russianPluralRule(n, 4)

    it('zero → index 0: 0', () => {
      expect(rule(0)).toBe(0)
    })

    it('one → index 1: 1, 21, 31', () => {
      expect(rule(1)).toBe(1)
      expect(rule(21)).toBe(1)
      expect(rule(31)).toBe(1)
    })

    it('few → index 2: 2, 3, 4, 22', () => {
      expect(rule(2)).toBe(2)
      expect(rule(3)).toBe(2)
      expect(rule(4)).toBe(2)
      expect(rule(22)).toBe(2)
    })

    it('many → index 3: 5, 11, 12, 14, 20, 25', () => {
      expect(rule(5)).toBe(3)
      expect(rule(11)).toBe(3)
      expect(rule(12)).toBe(3)
      expect(rule(14)).toBe(3)
      expect(rule(20)).toBe(3)
      expect(rule(25)).toBe(3)
    })
  })
})
