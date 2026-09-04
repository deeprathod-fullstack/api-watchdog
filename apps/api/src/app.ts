import express, { type Express, type RequestHandler } from 'express';
import type pg from 'pg';

import { type Config } from '@api-watchdog/shared';

import { createAuthRouter } from './auth/routes.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';

/**
 * Everything the app needs from the outside world.
 *
 * Passed in rather than imported so that construction stays a pure function:
 * tests decide which database and configuration the app runs against, and no
 * module reaches for a global connection or `process.env` on its own.
 */
export interface AppDependencies {
  config: Config;
  db: pg.Pool;
  /** Applied to the credential endpoints; injected so tests can bypass it. */
  authRateLimiter: RequestHandler;
}

/**
 * Build the Express application without binding a port.
 *
 * Keeping construction separate from `listen()` is what lets integration tests
 * drive the app in-process (see `test/health.test.ts`): no real port, no
 * startup races, no flaky waits.
 */
export function createApp({
  config,
  db,
  authRateLimiter,
}: AppDependencies): Express {
  const app = express();

  // Do not advertise the server implementation to anyone scanning.
  app.disable('x-powered-by');

  // A body parser without a limit is a cheap memory-exhaustion vector.
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);
  app.use(createAuthRouter(db, config, authRateLimiter));

  // Order matters: unmatched routes become 404s, then all errors funnel into
  // the single error handler, which must be registered last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
