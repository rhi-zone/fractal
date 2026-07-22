import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  base: "/fractal/playground/",
  plugins: [solid()],
  server: {
    port: 5173,
  },
})
