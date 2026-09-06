import express, { type Express, type RequestHandler } from 'express';
import type pg from 'pg';

import { type Config } from '@api-watchdog/shared';

import { createAuthRouter } from './auth/routes.js';
import { createDashboardRouter } from './dashboard/routes.js';
import type { CheckExecutor } from './checks/service.js';
import { createMonitorsRouter } from './monitors/routes.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import type { CheckScheduler } from './queue/scheduler.js';
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
  /** Applied to monitor creation; injected so tests can bypass it. */
  monitorRateLimiter: RequestHandler;
  /** Applied to manual checks; stricter, and injected for the same reason. */
  manualCheckRateLimiter: RequestHandler;
  /**
   * The guard, resolver and HTTP client a manual check runs through.
   *
   * Injected so tests can point the same pipeline at a local server. The
   * production triple is assembled in the process entry point, and no
   * environment variable selects between them.
   */
  checkExecutor: CheckExecutor;
  /**
   * Keeps the background schedule in step with monitor writes.
   *
   * Injected like everything else: the API owns scheduling but knows it only
   * through this interface, so CRUD tests need no Redis and the process entry
   * point is the only place that decides on a real BullMQ queue.
   */
  scheduler: CheckScheduler;
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
  monitorRateLimiter,
  manualCheckRateLimiter,
  checkExecutor,
  scheduler,
}: AppDependencies): Express {
  const app = express();

  // Do not advertise the server implementation to anyone scanning.
  app.disable('x-powered-by');

  // A body parser without a limit is a cheap memory-exhaustion vector.
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);
  app.use(createAuthRouter(db, config, authRateLimiter));
  app.use(createDashboardRouter(db, config));
  app.use(
    createMonitorsRouter({
      db,
      config,
      createRateLimiter: monitorRateLimiter,
      manualCheckRateLimiter,
      checkExecutor,
      scheduler,
    }),
  );

  // Order matters: unmatched routes become 404s, then all errors funnel into
  // the single error handler, which must be registered last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
