import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalHttp',
      fileName: 'http',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core'],
    },
  },
})
