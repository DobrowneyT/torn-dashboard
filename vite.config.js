import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/torn-forge-oc-system/',
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
  },
})