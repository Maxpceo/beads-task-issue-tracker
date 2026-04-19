import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock vue-i18n so useLocale can be imported outside Nuxt runtime.
// The mock exposes a mutable i18nLocale ref that tests can inspect.
const i18nLocale = { value: 'en' }

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ locale: i18nLocale }),
}))

function createMemoryStorage(): Storage {
  let data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => { data = new Map() },
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)) },
    removeItem: (key: string) => { data.delete(key) },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
  }
}

/** Import a fresh module instance (resets module-level singleton). */
async function importFresh() {
  vi.resetModules()
  // Re-apply the mock after resetModules clears the module registry
  vi.mock('vue-i18n', () => ({
    useI18n: () => ({ locale: i18nLocale }),
  }))
  return import('~/composables/useLocale')
}

describe('useLocale', () => {
  beforeEach(() => {
    const storage = createMemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      writable: true,
      configurable: true,
    })
    // Reset mocked i18n locale
    i18nLocale.value = 'en'
    // Reset navigator.language to a safe default
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US' },
      writable: true,
      configurable: true,
    })
  })

  it('first-launch-ru: empty localStorage + ru-RU navigator → locale=ru, isAuto=true', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'ru-RU' },
      writable: true,
      configurable: true,
    })
    const { useLocale } = await importFresh()
    const { locale, isAuto } = useLocale()

    expect(locale.value).toBe('ru')
    expect(isAuto.value).toBe(true)
  })

  it('first-launch-en: empty localStorage + en-US navigator → locale=en', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US' },
      writable: true,
      configurable: true,
    })
    const { useLocale } = await importFresh()
    const { locale } = useLocale()

    expect(locale.value).toBe('en')
  })

  it('first-launch-de: empty localStorage + de-DE navigator → locale=en (fallback)', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'de-DE' },
      writable: true,
      configurable: true,
    })
    const { useLocale } = await importFresh()
    const { locale } = useLocale()

    expect(locale.value).toBe('en')
  })

  it('locale-variants: ru, ru-BY, ru-RU all resolve to ru', async () => {
    for (const lang of ['ru', 'ru-BY', 'ru-RU']) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { language: lang },
        writable: true,
        configurable: true,
      })
      const { useLocale } = await importFresh()
      const { locale } = useLocale()
      expect(locale.value, `expected 'ru' for navigator.language='${lang}'`).toBe('ru')
    }
  })

  it('explicit-override: localStorage=en + ru-RU navigator → locale=en, isAuto=false', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'ru-RU' },
      writable: true,
      configurable: true,
    })
    // Pre-seed localStorage with an explicit choice
    localStorage.setItem('beads:locale', 'en')

    const { useLocale } = await importFresh()
    const { locale, isAuto } = useLocale()

    expect(locale.value).toBe('en')
    expect(isAuto.value).toBe(false)
  })

  it('reset-to-auto: start with explicit en, setLocale(auto) → localStorage=null, isAuto=true', async () => {
    localStorage.setItem('beads:locale', 'en')

    const { useLocale } = await importFresh()
    const { locale, isAuto, setLocale } = useLocale()

    expect(isAuto.value).toBe(false)
    expect(locale.value).toBe('en')

    setLocale('auto')

    expect(isAuto.value).toBe(true)
    expect(localStorage.getItem('beads:locale')).toBeNull()
  })

  it('corrupt-localStorage: garbage value is ignored, fallback to navigator.language', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'ru-RU' },
      writable: true,
      configurable: true,
    })
    localStorage.setItem('beads:locale', 'garbage')

    const { useLocale } = await importFresh()
    const { locale, isAuto } = useLocale()

    // Corrupt value ignored → auto mode → navigator says ru
    expect(locale.value).toBe('ru')
    expect(isAuto.value).toBe(true)
  })

  it('setLocale persists to localStorage', async () => {
    const { useLocale } = await importFresh()
    const { setLocale } = useLocale()

    setLocale('ru')

    expect(localStorage.getItem('beads:locale')).toBe('ru')
  })

  it('setLocale updates vue-i18n locale immediately', async () => {
    const { useLocale } = await importFresh()
    const { setLocale } = useLocale()

    setLocale('ru')

    expect(i18nLocale.value).toBe('ru')
  })
})
