/**
 * CLDR plural rule для русского языка.
 *
 * Категории:
 *   one  — mod10 === 1 && mod100 !== 11               (1, 21, 31, 101...)
 *   few  — mod10 in 2..4 && (mod100 < 12 || mod100 > 14) (2-4, 22-24, 102-104...)
 *   many — всё остальное (0, 5-20, 11-14, 25...)
 *
 * Поддерживает два режима через choicesLength:
 *   3 — стандартный:  [one, few, many]           → индексы 0, 1, 2
 *   4 — с zero-формой: [zero, one, few, many]    → индексы 0, 1, 2, 3
 *
 * Используется в i18n.config.ts как pluralRules.ru.
 *
 * @param choice       — число для плюрализации
 * @param choicesLength — количество форм в translation-ключе (3 или 4)
 * @returns индекс нужной формы
 */
export function russianPluralRule(choice: number, choicesLength: number): number {
  const abs = Math.abs(choice)
  const mod10 = abs % 10
  const mod100 = abs % 100

  // zero-форма: только при явном choicesLength === 4
  if (choicesLength === 4 && abs === 0) {
    return 0
  }

  const offset = choicesLength === 4 ? 1 : 0

  // one: 1, 21, 31, 41, 51, 61, 71, 81, 91, 101...
  if (mod10 === 1 && mod100 !== 11) {
    return offset + 0 // one
  }

  // few: 2-4, 22-24, 32-34...  (но не 12-14)
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return offset + 1 // few
  }

  // many: всё остальное
  return offset + 2
}
