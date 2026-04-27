import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import type { Plugin } from 'vite'

// Reuse the same nuxt-meta transform used in the main test config
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
  // Bench files live in tests/bench/ — they import app/ utils (pure TS, no DOM needed).
  // esbuild tsconfigRaw overrides the tsconfig resolution so the bench config can run
  // without a generated .nuxt/tsconfig.json (which only exists after `nuxt prepare`).
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/bench/**/*.bench.ts'],
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, 'app'),
    },
  },
})
