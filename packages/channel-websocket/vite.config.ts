import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalChannelWebsocket',
      fileName: 'channel-websocket',
    },
    rollupOptions: {
      external: [
        '@rhi-zone/fractal-core',
        '@rhi-zone/fractal-transport',
        '@rhi-zone/fractal-codec-json',
        '@rhi-zone/fractal-protocol-correlation',
      ],
    },
  },
})
