import { mergeConfig } from 'vite'
import { resolve } from 'node:path'
import official from '../web/vite.config.ts'

export default mergeConfig(official, {
  publicDir: '../web/public',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        setup: resolve(import.meta.dirname, 'setup.html'),
      },
    },
  },
})
