import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalStandardSchema',
      fileName: 'standard-schema',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core', '@standard-schema/spec'],
    },
  },
})
