import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalTransport',
      fileName: 'transport',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core'],
    },
  },
})
