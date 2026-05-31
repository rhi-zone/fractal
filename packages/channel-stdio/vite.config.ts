import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalChannelStdio',
      fileName: 'channel-stdio',
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
