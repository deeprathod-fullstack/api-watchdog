import { randomUUID } from 'node:crypto';

import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import request from 'supertest';

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
 * Rate limiters are bypassed in tests.
 *
 * The integration tests make far more requests than the production limits
 * allow, and what they are checking is the auth and monitor logic, not the
 * limiter's counter.
 */
const passthroughRateLimiter: RequestHandler = (_req, _res, next) => {
  next();
};

export function buildTestApp(config: Config, db: pg.Pool): Express {
  return createApp({
    config,
    db,
    authRateLimiter: passthroughRateLimiter,
    monitorRateLimiter: passthroughRateLimiter,
  });
}

/** An isolated pool the test file owns and closes, never the process-wide one. */
export function testPool(config: Config): pg.Pool {
  return createPool(config);
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

/**
 * Register a real user through the HTTP API and return their token.
 *
 * Real users, not hand-inserted rows: ownership tests are only meaningful if
 * the tokens and rows were produced by the same code paths a client uses.
 * Emails are unique per call so repeated runs never collide.
 */
export async function registerTestUser(app: Express): Promise<TestUser> {
  const email = `user-${randomUUID()}@example.test`;

  const response = await request(app).post('/api/auth/register').send({
    name: 'Test User',
    email,
    password: 'correct horse battery staple',
  });

  if (response.status !== 201) {
    throw new Error(`registration failed with ${String(response.status)}`);
  }

  const body = response.body as { user: { id: string }; token: string };

  return { id: body.user.id, email, token: body.token };
}

/** Remove the users these tests created; monitors cascade with them. */
export async function deleteTestUsers(
  db: pg.Pool,
  users: TestUser[],
): Promise<void> {
  await db.query('DELETE FROM users WHERE id = ANY($1)', [
    users.map((user) => user.id),
  ]);
}
