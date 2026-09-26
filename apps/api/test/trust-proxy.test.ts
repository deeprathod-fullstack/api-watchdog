import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthRateLimiter } from '../src/middleware/rate-limit.js';
import { buildTestApp, testConfig, testPool } from './helpers.js';

const config = testConfig();

/**
 * The API trusts exactly one proxy hop (Nginx), so the rate limiters must key
 * on the client address Nginx forwards, not on Nginx's own address.
 *
 * Each test builds its own app with the real credential limiter, so every test
 * starts with empty buckets. The requests carry an empty body: validation
 * rejects them with a 400, but the limiter runs first and counts them, so this
 * needs no user rows and no bcrypt work.
 *
 * Addresses are from the documentation ranges (RFC 5737), never real hosts.
 */
function limitedApp() {
  return buildTestApp(config, testPool(config), {
    authRateLimiter: createAuthRateLimiter(),
  });
}

/** Exhaust one forwarded address's login budget (10 per window). */
async function useUpBudget(
  app: ReturnType<typeof limitedApp>,
  forwardedFor: string,
) {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', forwardedFor)
      .send({});
    statuses.push(response.status);
  }
  expect(statuses).not.toContain(429);
}

function login(app: ReturnType<typeof limitedApp>, forwardedFor: string) {
  return request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', forwardedFor)
    .send({});
}

describe('trust proxy: rate limits see the forwarded client address', () => {
  it('limits the forwarded client once its budget is spent', async () => {
    const app = limitedApp();
    await useUpBudget(app, '203.0.113.10');

    const response = await login(app, '203.0.113.10');

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many requests, please try again later',
      },
    });
  });

  it('gives a different forwarded client its own bucket', async () => {
    // Every request here reaches the API from the same peer — as they all do
    // from Nginx. Without trust proxy they would share one bucket and this
    // second client would be refused for the first one's attempts.
    const app = limitedApp();
    await useUpBudget(app, '203.0.113.10');

    const response = await login(app, '203.0.113.20');

    expect(response.status).not.toBe(429);
  });

  it('ignores addresses the client wrote into X-Forwarded-For itself', async () => {
    // Nginx appends the real peer to whatever the client sent, so a client
    // cannot remove its own address — only prepend fakes. With exactly one
    // trusted hop, only the right-most entry counts. `trust proxy = true`
    // would read the left-most, fake one and hand out a fresh bucket.
    const app = limitedApp();
    await useUpBudget(app, '203.0.113.10');

    const response = await login(app, '198.51.100.99, 203.0.113.10');

    expect(response.status).toBe(429);
  });
});
