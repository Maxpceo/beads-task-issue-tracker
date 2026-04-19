export type DateLocale = 'en' | 'ru'

const INTL_LOCALE: Record<DateLocale, string> = {
  en: 'en-US',
  ru: 'ru-RU',
}

const OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
}

/**
 * Format a date value into a human-readable string using the given locale.
 *
 * @param input - ISO date string, Date object, null, or undefined
 * @param locale - Display locale: 'en' (default) or 'ru'
 * @returns Formatted date string, or '-' for null/undefined/invalid input
 */
export function formatDate(
  input: string | Date | null | undefined,
  locale: DateLocale = 'en'
): string {
  if (input == null) return '-'
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], OPTIONS).format(date)
}

/**
 * Format a date value into a human-readable time string (hours:minutes) using the given locale.
 *
 * @param input - ISO date string, Date object, null, or undefined
 * @param locale - Display locale: 'en' (default) or 'ru'
 * @returns Formatted time string (locale-aware AM/PM vs 24h), or '' for null/undefined/invalid input
 */
export function formatTime(
  input: string | Date | null | undefined,
  locale: DateLocale = 'en'
): string {
  if (input == null) return ''
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
