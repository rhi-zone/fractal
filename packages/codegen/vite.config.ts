import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        '@rhi-zone/fractal-core',
        '@rhi-zone/fractal-openapi',
        '@rhi-zone/fractal-client',
        /^node:/,
      ],
    },
  },
})
