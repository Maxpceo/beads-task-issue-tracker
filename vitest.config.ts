import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import type { Plugin } from 'vite'

// Nuxt defines import.meta.client/server at build time.
// In Vitest (jsdom), replace these literals so app/ composables work without guards.
function nuxtMetaPlugin(): Plugin {
  return {
    name: 'nuxt-import-meta-client',
    transform(code, id) {
      if (!id.includes('/app/') || id.includes('/node_modules/')) return
      return code
        .replace(/import\.meta\.client/g, 'true')
        .replace(/import\.meta\.server/g, 'false')
    },
  }
}

export default defineConfig({
  plugins: [nuxtMetaPlugin()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, 'app'),
      '@earendil-works/pi-tui': resolve(__dirname, 'tests/mocks/pi-tui.ts'),
    },
  },
})
