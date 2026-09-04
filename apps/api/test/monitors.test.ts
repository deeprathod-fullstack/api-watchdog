import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MAX_MONITORS_PER_USER } from '../src/monitors/service.js';
import {
  buildTestApp,
  deleteTestUsers,
  registerTestUser,
  testConfig,
  testPool,
  type TestUser,
} from './helpers.js';

/**
 * Integration tests against the real PostgreSQL from docker-compose
 * (`npm run db:migrate` must have been applied).
 *
 * Two real users throughout: ownership is the thing most worth testing here,
 * and it cannot be tested with one account.
 */
const config = testConfig();
const db = testPool(config);
const app: Express = buildTestApp(config, db);

let alice: TestUser;
let bob: TestUser;

const monitorSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  method: z.literal('GET'),
  expectedStatus: z.number().int(),
  intervalSeconds: z.number().int(),
  timeoutMs: z.number().int(),
  headers: z.record(z.string(), z.string()),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const validMonitor = {
  name: 'Example API',
  url: 'https://example.com/Status?Check=1',
  intervalSeconds: 300,
  timeoutMs: 5000,
};

/** Create a monitor owned by `user` and return its API representation. */
async function createMonitor(
  user: TestUser,
  overrides: Record<string, unknown> = {},
): Promise<z.infer<typeof monitorSchema>> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ ...validMonitor, ...overrides });

  expect(response.status).toBe(201);

  return z.strictObject({ monitor: monitorSchema }).parse(response.body)
    .monitor;
}

beforeAll(async () => {
  alice = await registerTestUser(app);
  bob = await registerTestUser(app);
});

afterAll(async () => {
  // Monitors, check results and incidents cascade from the user rows.
  await deleteTestUsers(db, [alice, bob]);
  await db.end();
});

describe('POST /api/monitors', () => {
  it('creates a monitor with the documented defaults', async () => {
    const monitor = await createMonitor(alice, { name: 'Defaults' });

    expect(monitor.method).toBe('GET');
    expect(monitor.expectedStatus).toBe(200);
    expect(monitor.active).toBe(true);
    expect(monitor.headers).toEqual({});
    // URL case is preserved: paths and query strings are case-sensitive.
    expect(monitor.url).toBe(validMonitor.url);
  });

  it('accepts an uppercase scheme and stores it normalised', async () => {
    // The scheme is case-insensitive per RFC 3986, but the table's CHECK is a
    // case-sensitive regex. Without normalisation this was accepted by the
    // schema and then rejected by the database, with the wrong error message.
    const monitor = await createMonitor(alice, {
      name: 'Uppercase scheme',
      url: 'HTTPS://example.com/Status?Check=1',
    });

    expect(monitor.url).toBe('https://example.com/Status?Check=1');
  });

  it('advertises the new resource in the Location header', async () => {
    const response = await request(app)
      .post('/api/monitors')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ ...validMonitor, name: 'Located' });

    expect(response.status).toBe(201);
    const { monitor } = z
      .strictObject({ monitor: monitorSchema })
      .parse(response.body);
    expect(response.headers.location).toBe(`/api/monitors/${monitor.id}`);
  });

  it('never lets the caller choose the owner or the id', async () => {
    const response = await request(app)
      .post('/api/monitors')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        ...validMonitor,
        id: randomUUID(),
        user_id: bob.id,
        userId: bob.id,
      });

    // Unknown keys are rejected outright, so mass assignment cannot even be
    // attempted, let alone succeed.
    expect(response.status).toBe(400);
    expect(errorSchema.parse(response.body).error.code).toBe(
      'validation_failed',
    );

    const bobList = await request(app)
      .get('/api/monitors')
      .set('Authorization', `Bearer ${bob.token}`);
    expect((bobList.body as { monitors: unknown[] }).monitors).toHaveLength(0);
  });

  it('rejects invalid field values', async () => {
    const cases: Record<string, unknown>[] = [
      { url: 'file:///etc/passwd' },
      { url: 'ftp://example.com' },
      { url: 'not a url' },
      { name: '' },
      { name: 'x'.repeat(101) },
      { intervalSeconds: 0 },
      { intervalSeconds: -60 },
      { timeoutMs: 999 },
      { timeoutMs: 30_001 },
      { expectedStatus: 99 },
      { expectedStatus: 600 },
      { method: 'POST' },
      // Types are not coerced: a JSON body already carries real types.
      { intervalSeconds: '300' },
      { active: 'yes' },
      // Cross-field rule: the check must finish before the next one is due.
      { intervalSeconds: 2, timeoutMs: 5000 },
      { headers: [] },
      { headers: 'x' },
    ];

    for (const overrides of cases) {
      const response = await request(app)
        .post('/api/monitors')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ ...validMonitor, ...overrides });

      expect(
        response.status,
        `expected 400 for ${JSON.stringify(overrides)}`,
      ).toBe(400);
      expect(errorSchema.parse(response.body).error.code).toBe(
        'validation_failed',
      );
    }
  });

  it('enforces the per-user monitor cap', async () => {
    const capUser = await registerTestUser(app);

    try {
      for (let i = 0; i < MAX_MONITORS_PER_USER; i += 1) {
        await createMonitor(capUser, { name: `Monitor ${String(i)}` });
      }

      const overflow = await request(app)
        .post('/api/monitors')
        .set('Authorization', `Bearer ${capUser.token}`)
        .send({ ...validMonitor, name: 'One too many' });

      expect(overflow.status).toBe(409);
      expect(errorSchema.parse(overflow.body).error.code).toBe(
        'monitor_limit_reached',
      );

      const list = await request(app)
        .get('/api/monitors')
        .set('Authorization', `Bearer ${capUser.token}`);
      expect((list.body as { monitors: unknown[] }).monitors).toHaveLength(
        MAX_MONITORS_PER_USER,
      );
    } finally {
      await deleteTestUsers(db, [capUser]);
    }
  });
});

describe('monitor headers', () => {
  it('stores and returns non-secret headers', async () => {
    const headers = { 'X-Trace-Id': 'abc-123', Accept: 'application/json' };
    const monitor = await createMonitor(alice, {
      name: 'With headers',
      headers,
    });

    expect(monitor.headers).toEqual(headers);
  });

  it('rejects secret-bearing headers whatever the casing', async () => {
    const forbidden = [
      { Authorization: 'Bearer sk_live_secret' },
      { authorization: 'Bearer sk_live_secret' },
      { AUTHORIZATION: 'Basic abc' },
      { Cookie: 'session=abc' },
      { 'Set-Cookie': 'session=abc' },
      { 'Proxy-Authorization': 'Basic abc' },
      { 'X-Api-Key': 'sk_live_secret' },
      { 'api-key': 'sk_live_secret' },
    ];

    for (const headers of forbidden) {
      const response = await request(app)
        .post('/api/monitors')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ ...validMonitor, name: 'Secret header', headers });

      expect(
        response.status,
        `expected 400 for ${JSON.stringify(headers)}`,
      ).toBe(400);

      const body = errorSchema.parse(response.body);
      expect(body.error.code).toBe('validation_failed');
      // The header value must never be echoed back — an error message is the
      // one place a rejected secret would otherwise be written down.
      expect(JSON.stringify(body)).not.toContain('sk_live_secret');
      expect(JSON.stringify(body)).not.toContain('session=abc');
    }
  });

  it('rejects header names and values that could forge a request', async () => {
    const malformed = [
      { 'X-Bad Name': 'value' },
      { 'X-Bad\nName': 'value' },
      { 'X-Trace': 'value\r\nX-Injected: yes' },
      { 'X-Trace': 'value\nX-Injected: yes' },
      { 'X-Trace': 'x'.repeat(1025) },
      { 'X-Trace': 'ünicode' },
    ];

    for (const headers of malformed) {
      const response = await request(app)
        .post('/api/monitors')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ ...validMonitor, name: 'Malformed header', headers });

      expect(
        response.status,
        `expected 400 for ${JSON.stringify(headers)}`,
      ).toBe(400);
    }
  });

  it('rejects more headers than the cap allows', async () => {
    const headers = Object.fromEntries(
      Array.from({ length: 11 }, (_value, index) => [
        `X-Header-${String(index)}`,
        'value',
      ]),
    );

    const response = await request(app)
      .post('/api/monitors')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ ...validMonitor, name: 'Too many headers', headers });

    expect(response.status).toBe(400);
  });
});

describe('GET /api/monitors', () => {
  it('returns only the caller monitors, newest first', async () => {
    const owner = await registerTestUser(app);

    try {
      const first = await createMonitor(owner, { name: 'First' });
      const second = await createMonitor(owner, { name: 'Second' });
      await createMonitor(bob, { name: 'Bob only' });

      const response = await request(app)
        .get('/api/monitors')
        .set('Authorization', `Bearer ${owner.token}`);

      expect(response.status).toBe(200);
      const { monitors } = z
        .strictObject({ monitors: z.array(monitorSchema) })
        .parse(response.body);

      expect(monitors.map((monitor) => monitor.id)).toEqual([
        second.id,
        first.id,
      ]);
    } finally {
      await deleteTestUsers(db, [owner]);
    }
  });
});

describe('GET /api/monitors/:id', () => {
  it('returns a monitor the caller owns', async () => {
    const monitor = await createMonitor(alice, { name: 'Readable' });

    const response = await request(app)
      .get(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(response.status).toBe(200);
    expect(
      z.strictObject({ monitor: monitorSchema }).parse(response.body).monitor,
    ).toEqual(monitor);
  });

  it('answers 404 for a malformed id instead of a database error', async () => {
    for (const id of ['not-a-uuid', '123', '../../etc/passwd']) {
      const response = await request(app)
        .get(`/api/monitors/${encodeURIComponent(id)}`)
        .set('Authorization', `Bearer ${alice.token}`);

      expect(response.status).toBe(404);
      expect(errorSchema.parse(response.body).error.code).toBe('not_found');
    }
  });

  it('answers 404 for an id that does not exist', async () => {
    const response = await request(app)
      .get(`/api/monitors/${randomUUID()}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/monitors/:id', () => {
  it('applies a partial update and advances updated_at', async () => {
    const monitor = await createMonitor(alice, { name: 'Before' });

    const response = await request(app)
      .patch(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'After' });

    expect(response.status).toBe(200);
    const updated = z
      .strictObject({ monitor: monitorSchema })
      .parse(response.body).monitor;

    expect(updated.name).toBe('After');
    // Untouched fields keep their values.
    expect(updated.url).toBe(monitor.url);
    expect(updated.intervalSeconds).toBe(monitor.intervalSeconds);
    expect(updated.createdAt).toBe(monitor.createdAt);
    // The column default only fires on INSERT, so the UPDATE must set this.
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(monitor.updatedAt).getTime(),
    );
  });

  it('pauses and resumes a monitor', async () => {
    const monitor = await createMonitor(alice, { name: 'Pausable' });

    const paused = await request(app)
      .patch(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ active: false });
    expect(paused.status).toBe(200);
    expect(
      (paused.body as { monitor: { active: boolean } }).monitor.active,
    ).toBe(false);

    const resumed = await request(app)
      .patch(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ active: true });
    expect(
      (resumed.body as { monitor: { active: boolean } }).monitor.active,
    ).toBe(true);
  });

  it('replaces the headers object wholesale', async () => {
    const monitor = await createMonitor(alice, {
      name: 'Header patch',
      headers: { 'X-One': '1', 'X-Two': '2' },
    });

    const response = await request(app)
      .patch(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ headers: { 'X-Three': '3' } });

    expect(response.status).toBe(200);
    expect(
      (response.body as { monitor: { headers: unknown } }).monitor.headers,
    ).toEqual({ 'X-Three': '3' });
  });

  it('rejects an empty patch rather than reporting a silent success', async () => {
    const monitor = await createMonitor(alice, { name: 'Empty patch' });

    const response = await request(app)
      .patch(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({});

    expect(response.status).toBe(400);
    expect(errorSchema.parse(response.body).error.code).toBe(
      'validation_failed',
    );
  });

  it('rejects unknown and immutable fields', async () => {
    const monitor = await createMonitor(alice, { name: 'Immutable' });

    for (const patch of [
      { id: randomUUID() },
      { user_id: bob.id },
      { userId: bob.id },
      { createdAt: new Date().toISOString() },
      { updatedAt: new Date().toISOString() },
      { nonsense: true },
    ]) {
      const response = await request(app)
        .patch(`/api/monitors/${monitor.id}`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send(patch);

      expect(response.status, `expected 400 for ${JSON.stringify(patch)}`).toBe(
        400,
      );
    }

    // Ownership is unchanged after every attempt.
    const stillAlices = await request(app)
      .get(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(stillAlices.status).toBe(200);
  });

  it('reports a cross-field violation against the stored row as a 400', async () => {
    // Individually valid: 25000ms is inside the allowed timeout range. Invalid
    // against the stored 10s interval only once merged, which is why the
    // database constraint is the authority on this rule.
    const monitor = await createMonitor(alice, {
      name: 'Cross field',
      intervalSeconds: 10,
      timeoutMs: 5000,
    });

    const response = await request(app)
      .patch(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ timeoutMs: 25_000 });

    expect(response.status).toBe(400);
    expect(errorSchema.parse(response.body).error.code).toBe(
      'validation_failed',
    );

    // The rejected write left nothing behind.
    const after = await request(app)
      .get(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(
      (after.body as { monitor: { timeoutMs: number } }).monitor.timeoutMs,
    ).toBe(5000);
  });

  it('answers 404 for a malformed or unknown id', async () => {
    for (const id of ['not-a-uuid', randomUUID()]) {
      const response = await request(app)
        .patch(`/api/monitors/${id}`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ name: 'Nope' });

      expect(response.status).toBe(404);
    }
  });
});

describe('DELETE /api/monitors/:id', () => {
  it('deletes a monitor the caller owns and is then 404', async () => {
    const monitor = await createMonitor(alice, { name: 'Deletable' });

    const deleted = await request(app)
      .delete(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(deleted.status).toBe(204);
    expect(deleted.body).toEqual({});

    const second = await request(app)
      .delete(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(second.status).toBe(404);
  });

  it('takes check results and incidents with it', async () => {
    const monitor = await createMonitor(alice, { name: 'With history' });

    // Rows written directly: the check pipeline that would normally produce
    // them does not exist yet, and what is under test is the cascade.
    await db.query(
      `INSERT INTO check_results
              (monitor_id, status, http_status, response_time_ms)
       VALUES ($1, 'success', 200, 123)`,
      [monitor.id],
    );
    await db.query(
      `INSERT INTO incidents (monitor_id, status, started_at, failure_count)
       VALUES ($1, 'open', now(), 3)`,
      [monitor.id],
    );

    const response = await request(app)
      .delete(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(response.status).toBe(204);

    const results = await db.query(
      'SELECT 1 FROM check_results WHERE monitor_id = $1',
      [monitor.id],
    );
    const incidents = await db.query(
      'SELECT 1 FROM incidents WHERE monitor_id = $1',
      [monitor.id],
    );

    expect(results.rowCount).toBe(0);
    expect(incidents.rowCount).toBe(0);
  });
});

describe('ownership boundary', () => {
  it('never lets one user reach another user monitor', async () => {
    const monitor = await createMonitor(alice, { name: 'Alice private' });

    const attempts = [
      () =>
        request(app)
          .get(`/api/monitors/${monitor.id}`)
          .set('Authorization', `Bearer ${bob.token}`),
      () =>
        request(app)
          .patch(`/api/monitors/${monitor.id}`)
          .set('Authorization', `Bearer ${bob.token}`)
          .send({ name: 'Bob was here', active: false }),
      () =>
        request(app)
          .delete(`/api/monitors/${monitor.id}`)
          .set('Authorization', `Bearer ${bob.token}`),
    ];

    for (const attempt of attempts) {
      const response = await attempt();

      // 404, not 403: a 403 would confirm the id exists, which is an
      // enumeration oracle over another user's data.
      expect(response.status).toBe(404);
      if (response.status === 404) {
        expect(errorSchema.parse(response.body).error.code).toBe('not_found');
      }
    }

    // The status code alone is not enough — a DELETE that answered 404 while
    // still removing the row would otherwise pass. Assert the side effect.
    const stillThere = await request(app)
      .get(`/api/monitors/${monitor.id}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(stillThere.status).toBe(200);
    expect(
      z.strictObject({ monitor: monitorSchema }).parse(stillThere.body).monitor,
    ).toEqual(monitor);
  });

  it('keeps another user monitors out of the list', async () => {
    await createMonitor(alice, { name: 'Alice listed' });

    const response = await request(app)
      .get('/api/monitors')
      .set('Authorization', `Bearer ${bob.token}`);

    const { monitors } = z
      .strictObject({ monitors: z.array(monitorSchema) })
      .parse(response.body);

    expect(monitors.every((monitor) => monitor.name !== 'Alice listed')).toBe(
      true,
    );
  });
});

describe('authentication boundary', () => {
  it('rejects every monitor route without a usable token', async () => {
    const id = randomUUID();

    const calls = [
      () => request(app).post('/api/monitors').send(validMonitor),
      () => request(app).get('/api/monitors'),
      () => request(app).get(`/api/monitors/${id}`),
      () => request(app).patch(`/api/monitors/${id}`).send({ name: 'x' }),
      () => request(app).delete(`/api/monitors/${id}`),
    ];

    for (const call of calls) {
      const noHeader = await call();
      expect(noHeader.status).toBe(401);
      expect(errorSchema.parse(noHeader.body).error.code).toBe(
        'unauthenticated',
      );
    }

    // A syntactically valid but unsigned-by-us token is equally rejected.
    const forged = await request(app)
      .get('/api/monitors')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(forged.status).toBe(401);
  });
});
