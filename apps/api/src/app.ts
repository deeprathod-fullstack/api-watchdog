import express, { type Express } from 'express';

import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';

/**
 * Build the Express application without binding a port.
 *
 * Keeping construction separate from `listen()` is what lets integration tests
 * drive the app in-process (see `test/health.test.ts`): no real port, no
 * startup races, no flaky waits.
 */
export function createApp(): Express {
  const app = express();

  // Do not advertise the server implementation to anyone scanning.
  app.disable('x-powered-by');

  // A body parser without a limit is a cheap memory-exhaustion vector.
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);

  // Order matters: unmatched routes become 404s, then all errors funnel into
  // the single error handler, which must be registered last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
