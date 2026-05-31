import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: {
        http:   resolve(__dirname, 'src/index.ts'),
        web:    resolve(__dirname, 'src/web.ts'),
        client: resolve(__dirname, 'src/client.ts'),
        bun:    resolve(__dirname, 'src/bun.ts'),
        node:   resolve(__dirname, 'src/node.ts'),
      },
      name: 'FractalHttp',
    },
    rollupOptions: {
      external: ['@rhi-zone/fractal-core', '@rhi-zone/fractal-rpc-dispatch', 'node:http'],
    },
  },
})
