import { logFrontend } from '~/utils/bd-api'

export default defineNuxtPlugin(async () => {
  if (!import.meta.client) return
  if (!import.meta.dev) return

  try {
    const mod = await import('tauri-plugin-mcp')
    await mod.setupPluginListeners()
    logFrontend('info', '[tauri-mcp] plugin listeners registered').catch(() => {})
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
    logFrontend('warn', `[tauri-mcp] setup failed: ${msg}`).catch(() => {})
  }
})
