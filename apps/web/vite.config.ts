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
    /**
     * Poll for file changes instead of relying on filesystem events.
     *
     * Only when `VITE_USE_POLLING` is set, which Compose does for the
     * containerised dev server and nothing else does. Editing a file on a
     * Windows host does not deliver an inotify event to a Linux container
     * across a bind mount, so without this the server starts, serves, and then
     * silently never hot-reloads — the worst kind of failure, because it looks
     * like it is working.
     *
     * Off by default because polling re-stats the tree on an interval and
     * costs idle CPU. Running on the host, where events work, should not pay
     * for a problem it does not have.
     */
    watch: process.env.VITE_USE_POLLING
      ? { usePolling: true, interval: 300 }
      : undefined,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
