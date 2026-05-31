import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalFacade',
      fileName: 'facade',
    },
    rollupOptions: {
      external: [
        '@rhi-zone/fractal-core',
        '@rhi-zone/fractal-rpc-dispatch',
        '@rhi-zone/fractal-http',
        '@rhi-zone/fractal-rpc',
        '@rhi-zone/fractal-ipc',
        '@rhi-zone/fractal-client',
        '@rhi-zone/fractal-schema',
      ],
    },
  },
})
