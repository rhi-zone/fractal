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
        '@rhi-zone/fractal-transport',
        '@rhi-zone/fractal-codec-json',
        '@rhi-zone/fractal-codec-structured-clone',
        '@rhi-zone/fractal-protocol-correlation',
        '@rhi-zone/fractal-channel-http',
        '@rhi-zone/fractal-channel-http/web',
        '@rhi-zone/fractal-channel-http/bun',
        '@rhi-zone/fractal-channel-http/node',
        '@rhi-zone/fractal-channel-http/client',
        '@rhi-zone/fractal-channel-websocket',
        '@rhi-zone/fractal-channel-worker',
        '@rhi-zone/fractal-channel-stdio',
        '@rhi-zone/fractal-schema',
      ],
    },
  },
})
