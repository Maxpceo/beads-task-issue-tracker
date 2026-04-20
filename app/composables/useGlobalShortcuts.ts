import { useEventListener } from '@vueuse/core'
import { useCommandPalette } from '~/composables/useCommandPalette'

/**
 * Register global keyboard shortcuts.
 * Cmd+K / Ctrl+K — open command palette (Linear-style: even when focus is in an input).
 * Guard: if palette is already open, ignore repeated Cmd+K.
 */
export function useGlobalShortcuts() {
  const { open, openPalette } = useCommandPalette()

  useEventListener(window, 'keydown', (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      if (open.value) return
      e.preventDefault()
      openPalette()
    }
  })
}
