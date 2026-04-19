import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

type SupportedLocale = 'en' | 'ru'

// Nuxt's i18n plugin attaches a lazy-loading setLocale to the Composer —
// plain `locale.value = x` skips the locale-bundle loader, so non-default
// locales stay empty until setLocale() is called.
interface NuxtI18nComposer {
  setLocale?: (locale: string) => Promise<void>
}

/**
 * Resolve effective locale from navigator.language.
 * Returns 'ru' if language starts with 'ru', otherwise 'en'.
 */
function resolveFromNavigator(): SupportedLocale {
  if (typeof navigator !== 'undefined' && navigator.language.startsWith('ru')) {
    return 'ru'
  }
  return 'en'
}

/**
 * Validate a raw localStorage value.
 * Returns the value if it is a supported locale, otherwise null.
 */
function validateLocale(raw: string | null): SupportedLocale | null {
  if (raw === 'en' || raw === 'ru') return raw
  return null
}

// Module-level singleton — shared across all composable instances (same as useTheme pattern)
const _stored = ref<SupportedLocale | null>(null)
let _initialized = false

function initSingleton() {
  if (_initialized) return
  _initialized = true

  // Load initial value from localStorage.
  // The key stores a plain string ('en' or 'ru'), not JSON-encoded.
  // Invalid or absent values stay as null (auto mode).
  if (import.meta.client) {
    const raw = localStorage.getItem('beads:locale')
    _stored.value = validateLocale(raw)
  }
}

export function useLocale() {
  initSingleton()

  const i18n = useI18n()

  // Computed: effective locale — from storage if explicit, else from navigator
  const locale = computed((): SupportedLocale => {
    if (_stored.value !== null) return _stored.value
    return resolveFromNavigator()
  })

  // Computed: true when no explicit choice is stored (auto mode)
  const isAuto = computed(() => _stored.value === null)

  // Sync vue-i18n locale when effective locale changes (e.g. on init or external mutation).
  // Use Nuxt's setLocale when available so lazy-loaded locale bundles are fetched;
  // fall back to direct locale assignment in tests / non-Nuxt environments.
  const applyLocale = (resolved: SupportedLocale) => {
    const nuxtComposer = i18n as unknown as NuxtI18nComposer
    if (typeof nuxtComposer.setLocale === 'function') {
      nuxtComposer.setLocale(resolved).catch(() => {
        i18n.locale.value = resolved
      })
    } else {
      i18n.locale.value = resolved
    }
  }

  watch(
    locale,
    applyLocale,
    { immediate: true, flush: 'sync' }
  )

  const setLocale = (value: 'auto' | SupportedLocale): void => {
    if (value === 'auto') {
      _stored.value = null
      if (import.meta.client) {
        localStorage.removeItem('beads:locale')
      }
    } else {
      _stored.value = value
      if (import.meta.client) {
        localStorage.setItem('beads:locale', value)
      }
    }
    // Update vue-i18n locale immediately (not waiting for watch flush)
    applyLocale(locale.value)
  }

  return {
    locale,
    isAuto,
    setLocale,
  }
}
