import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Self-hosted stack serves the SPA at the domain root behind nginx.
  // (GitHub Pages needed base '/torn-forge-oc-system/'; that stays on main.)
  base: '/',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 3000,
    open: true,
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test.setup.js'],
  },
})