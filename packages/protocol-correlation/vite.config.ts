import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalProtocolCorrelation',
      fileName: 'protocol-correlation',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core', '@rhi-zone/fractal-transport'],
    },
  },
})
