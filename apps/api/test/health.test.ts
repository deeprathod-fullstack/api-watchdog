import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildTestApp, testConfig, testPool } from './helpers.js';

const config = testConfig();
// The health route touches no dependency, but the app now needs a pool to be
// built. It is never queried here, so no connection is ever opened.
const app = buildTestApp(config, testPool(config));

/**
 * The contract `/health` promises to its consumers (Docker HEALTHCHECK, and
 * later an AWS target group). Parsing rather than poking at fields means a
 * changed or missing field fails the test loudly.
 */
const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number().int().nonnegative(),
  timestamp: z.iso.datetime(),
});

const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

describe('GET /health', () => {
  it('reports liveness without touching any dependency', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(() => healthResponseSchema.parse(response.body)).not.toThrow();
  });

  it('does not advertise the server implementation', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('malformed requests', () => {
  it('rejects a body over the size limit with 413, not 500', async () => {
    const response = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('a'.repeat(200_000));

    expect(response.status).toBe(413);
    expect(errorResponseSchema.parse(response.body).error.code).toBe(
      'entity_too_large',
    );
  });

  it('rejects malformed JSON with 400, not 500', async () => {
    const response = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(response.body).error.code).toBe(
      'entity_parse_failed',
    );
  });
});

describe('unknown routes', () => {
  it('returns a structured 404 through the error handler', async () => {
    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(errorResponseSchema.parse(response.body)).toEqual({
      error: { code: 'not_found', message: 'Resource not found' },
    });
  });
});
