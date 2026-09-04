import type { Express, RequestHandler } from 'express';
import type pg from 'pg';

import { type Config, loadConfig, loadDotenv } from '@api-watchdog/shared';

import { createApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';

loadDotenv();

/**
 * Configuration for tests.
 *
 * A fixed signing secret keeps token tests deterministic and independent of
 * whatever the developer has in `.env`; `DATABASE_URL` is not defaulted, because
 * silently pointing the tests at some other database would be worse than
 * failing loudly.
 */
export function testConfig(): Config {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    JWT_SECRET: 'test-signing-secret-not-used-anywhere-else',
  });
}

/**
 * The rate limiter is bypassed in tests.
 *
 * The integration tests make far more than 10 credential requests, and what
 * they are checking is the auth logic, not the limiter's counter.
 */
const passthroughRateLimiter: RequestHandler = (_req, _res, next) => {
  next();
};

export function buildTestApp(config: Config, db: pg.Pool): Express {
  return createApp({ config, db, authRateLimiter: passthroughRateLimiter });
}

/** An isolated pool the test file owns and closes, never the process-wide one. */
export function testPool(config: Config): pg.Pool {
  return createPool(config);
}
