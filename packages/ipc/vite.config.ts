import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalIpc',
      fileName: 'ipc',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core', '@rhi-zone/fractal-rpc-dispatch'],
    },
  },
})
