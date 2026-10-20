import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.RUYI_SERVER_PORT || 5174}`, ws: true },
    },
  },
})
