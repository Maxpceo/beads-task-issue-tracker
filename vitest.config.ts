import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    define: {
      'import.meta.client': 'true',
      'import.meta.server': 'false',
    },
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, 'app'),
    },
  },
})
