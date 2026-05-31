import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalProtocolRequestResponse',
      fileName: 'protocol-request-response',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core', '@rhi-zone/fractal-transport'],
    },
  },
})
