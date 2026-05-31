import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: {
        http: resolve(__dirname, 'src/index.ts'),
        bun:  resolve(__dirname, 'src/bun.ts'),
      },
      name: 'FractalHttp',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core'],
    },
  },
})
