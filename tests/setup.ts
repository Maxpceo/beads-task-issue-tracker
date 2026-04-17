// Polyfill Nuxt's import.meta.client / import.meta.server for Vitest (jsdom environment)
Object.defineProperty(import.meta, 'client', { value: true, writable: true, configurable: true })
Object.defineProperty(import.meta, 'server', { value: false, writable: true, configurable: true })
