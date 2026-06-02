import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalClient',
      fileName: 'client',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core', '@rhi-zone/fractal-http'],
    },
  },
})
