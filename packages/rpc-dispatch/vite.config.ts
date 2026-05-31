import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalRpcDispatch',
      fileName: 'rpc-dispatch',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core'],
    },
  },
})
