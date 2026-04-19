import { logFrontend } from '~/utils/bd-api'

// Global state for dialog/panel visibility
const showUpdateDialog = ref(false)
const showAboutDialog = ref(false)
const showSettingsDialog = ref(false)
const showDebugPanel = ref(false)
let menuInitialized = false
let menuLocaleWatcherInstalled = false

export function useAppMenu() {
  const { t, locale } = useI18n()

  const buildMenu = async () => {
    if (typeof window === 'undefined' || (!window.__TAURI__ && !window.__TAURI_INTERNALS__)) return

    try {
      const { Menu, Submenu, MenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu')

      // App menu items
      const aboutItem = await MenuItem.new({
        text: t('menu.about'),
        action: () => {
          showAboutDialog.value = true
        },
      })
      const separator1 = await PredefinedMenuItem.new({ item: 'Separator' })

      const settingsItem = await MenuItem.new({
        text: t('menu.settings'),
        accelerator: 'CmdOrCtrl+,',
        action: () => {
          showSettingsDialog.value = true
        },
      })

      const checkUpdateItem = await MenuItem.new({
        text: t('menu.checkForUpdate'),
        action: () => {
          showUpdateDialog.value = true
        },
      })

      const showLogsItem = await MenuItem.new({
        text: t('menu.showLogs'),
        accelerator: 'CmdOrCtrl+Shift+L',
        action: () => {
          showDebugPanel.value = !showDebugPanel.value
        },
      })

      const separator2 = await PredefinedMenuItem.new({ item: 'Separator' })
      const servicesItem = await PredefinedMenuItem.new({ item: 'Services' })
      const separator3 = await PredefinedMenuItem.new({ item: 'Separator' })
      const hideItem = await PredefinedMenuItem.new({ item: 'Hide' })
      const hideOthersItem = await PredefinedMenuItem.new({ item: 'HideOthers' })
      const showAllItem = await PredefinedMenuItem.new({ item: 'ShowAll' })
      const separator4 = await PredefinedMenuItem.new({ item: 'Separator' })
      const quitItem = await PredefinedMenuItem.new({ item: 'Quit' })

      const appMenu = await Submenu.new({
        text: t('menu.app'),
        items: [
          aboutItem,
          separator1,
          settingsItem,
          checkUpdateItem,
          showLogsItem,
          separator2,
          servicesItem,
          separator3,
          hideItem,
          hideOthersItem,
          showAllItem,
          separator4,
          quitItem,
        ],
      })

      // Edit menu
      const undoItem = await PredefinedMenuItem.new({ item: 'Undo' })
      const redoItem = await PredefinedMenuItem.new({ item: 'Redo' })
      const editSeparator1 = await PredefinedMenuItem.new({ item: 'Separator' })
      const cutItem = await PredefinedMenuItem.new({ item: 'Cut' })
      const copyItem = await PredefinedMenuItem.new({ item: 'Copy' })
      const pasteItem = await PredefinedMenuItem.new({ item: 'Paste' })
      const selectAllItem = await PredefinedMenuItem.new({ item: 'SelectAll' })

      const editMenu = await Submenu.new({
        text: t('menu.edit'),
        items: [
          undoItem,
          redoItem,
          editSeparator1,
          cutItem,
          copyItem,
          pasteItem,
          selectAllItem,
        ],
      })

      // Window menu - use Maximize (Tauri displays as "Zoom" on macOS)
      const minimizeItem = await PredefinedMenuItem.new({ item: 'Minimize' })
      const maximizeItem = await PredefinedMenuItem.new({ item: 'Maximize' })
      const windowSeparator = await PredefinedMenuItem.new({ item: 'Separator' })
      const closeItem = await PredefinedMenuItem.new({ item: 'CloseWindow' })

      const windowMenu = await Submenu.new({
        text: t('menu.window'),
        items: [
          minimizeItem,
          maximizeItem,
          windowSeparator,
          closeItem,
        ],
      })

      // Create and set the menu
      const menu = await Menu.new({
        items: [appMenu, editMenu, windowMenu],
      })

      await menu.setAsAppMenu()
    } catch (error) {
      logFrontend('error', '[useAppMenu] Failed to initialize app menu: ' + (error instanceof Error ? error.message : String(error))).catch(() => {})
    }
  }

  const initializeMenu = async () => {
    if (menuInitialized) return
    if (typeof window === 'undefined' || (!window.__TAURI__ && !window.__TAURI_INTERNALS__)) return

    menuInitialized = true
    await buildMenu()

    if (!menuLocaleWatcherInstalled) {
      menuLocaleWatcherInstalled = true
      watch(locale, () => {
        buildMenu().catch(() => {})
      })
    }
  }

  return {
    showUpdateDialog,
    showAboutDialog,
    showSettingsDialog,
    showDebugPanel,
    initializeMenu,
  }
}
