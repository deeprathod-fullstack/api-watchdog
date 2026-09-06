import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dev server proxies `/api` to the backend so the browser talks to a single
 * origin. That keeps `VITE_API_BASE_URL` empty (relative) in development and
 * means the API needs no CORS configuration for local work.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
