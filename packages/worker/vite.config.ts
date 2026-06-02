import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalWorker',
      fileName: 'worker',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core'],
    },
  },
})
