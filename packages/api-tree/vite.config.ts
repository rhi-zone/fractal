import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FractalCore',
      fileName: 'core',
    },
    rollupOptions: {
      external: [],
    },
  },
})
