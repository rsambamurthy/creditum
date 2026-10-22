import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The API is reached at /api; in development and preview it is proxied to the local API server. */
const apiTarget = process.env.CREDITUM_API_PROXY ?? 'http://localhost:3000';
const proxy = { '/api': { target: apiTarget, changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { outDir: 'dist', sourcemap: true },
});
