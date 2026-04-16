import { logFrontend } from '~/utils/bd-api'

let windowModule: typeof import('@tauri-apps/api/window') | null = null
let setTitlePermissionDeniedLogged = false

// Pre-load the Tauri window module
if (import.meta.client) {
  import('@tauri-apps/api/window').then(mod => {
    windowModule = mod
  }).catch(() => {
    // Not in Tauri environment
  })
}

export function useTauriWindow() {
  const startDragging = () => {
    if (windowModule) {
      windowModule.getCurrentWindow().startDragging().catch(() => {
        // Ignore drag failures in unsupported environments.
      })
    }
  }

  const setWindowTitle = (title: string) => {
    if (windowModule) {
      windowModule.getCurrentWindow().setTitle(title).catch((error) => {
        // Some capability profiles may deny changing title; do not break app render.
        if (!setTitlePermissionDeniedLogged) {
          setTitlePermissionDeniedLogged = true
          logFrontend('warn', '[useTauriWindow] Unable to set window title: ' + (error instanceof Error ? error.message : String(error))).catch(() => {})
        }
      })
    }
  }

  return {
    startDragging,
    setWindowTitle,
  }
}
