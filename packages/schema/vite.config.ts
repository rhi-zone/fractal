import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalSchema',
      fileName: 'schema',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core'],
    },
  },
})
