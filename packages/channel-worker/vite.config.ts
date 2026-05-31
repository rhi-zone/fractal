import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalChannelWorker',
      fileName: 'channel-worker',
    },
    rollupOptions: {
      external: [
        '@rhi-zone/fractal-core',
        '@rhi-zone/fractal-transport',
        '@rhi-zone/fractal-codec-structured-clone',
        '@rhi-zone/fractal-protocol-correlation',
      ],
    },
  },
})
