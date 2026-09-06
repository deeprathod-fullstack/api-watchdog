import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Point at TypeScript source, not dist/, so tests never need a build
      // step and can never run against a stale compiled copy.
      '@api-watchdog/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],

    // One test file at a time.
    //
    // Most of this suite runs against the one real PostgreSQL and the one real
    // Redis from docker-compose. Individual tests scope their data to a user
    // they created, but some assertions are necessarily global — startup
    // reconciliation compares *every* active monitor against *every* job
    // scheduler — and those cannot be true while another file is concurrently
    // creating and deleting monitors.
    //
    // The alternative is a database per worker, which is real infrastructure
    // work for a suite that currently finishes in seconds. Revisit if it stops
    // finishing in seconds.
    fileParallelism: false,
  },
});
