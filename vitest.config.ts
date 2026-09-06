import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const sharedAlias = {
  // Point at TypeScript source, not dist/, so tests never need a build
  // step and can never run against a stale compiled copy.
  '@api-watchdog/shared': fileURLToPath(
    new URL('./packages/shared/src/index.ts', import.meta.url),
  ),
};

/**
 * Two projects, because the two halves of the repo need different runtimes:
 * the API and worker are Node, the web app needs a DOM. `npm test` still runs
 * everything in one command.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['apps/api/**/*.test.ts', 'packages/**/*.test.ts'],

          // Creates and migrates the suite's own database before any file
          // runs, so the tests never read or write development data.
          globalSetup: ['./apps/api/test/global-setup.ts'],

          // One test file at a time.
          //
          // Most of this suite runs against the one test database and the one
          // real Redis from docker-compose. Individual tests scope their data to
          // a user they created, but some assertions are necessarily global —
          // startup reconciliation compares *every* active monitor against
          // *every* job scheduler — and those cannot be true while another file
          // is concurrently creating and deleting monitors.
          //
          // The alternative is a database per worker, which is real
          // infrastructure work for a suite that currently finishes in seconds.
          // Revisit if it stops finishing in seconds.
          fileParallelism: false,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/test/**/*.test.{ts,tsx}'],
          setupFiles: ['./apps/web/test/setup.ts'],
        },
      },
    ],
  },
});
