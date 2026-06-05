import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        adapter: 'src/adapter.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core', 'node:http'],
    },
  },
})
