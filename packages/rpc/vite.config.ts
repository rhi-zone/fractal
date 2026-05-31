import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalRpc',
      fileName: 'rpc',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core', '@rhi-zone/fractal-rpc-dispatch'],
    },
  },
})
