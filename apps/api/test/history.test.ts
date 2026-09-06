import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ClassifiedCheck } from '../src/checks/classify.js';
import { recordCheck } from '../src/incidents/engine.js';
import {
  buildTestApp,
  deleteTestUsers,
  registerTestUser,
  testConfig,
  testPool,
  type TestUser,
} from './helpers.js';

/**
 * GET /api/monitors/:id/checks and /incidents.
 *
 * The two things worth testing on a read endpoint: that it returns the right
 * rows in the right order with a bounded page, and that it returns nothing at
 * all to somebody else's account.
 */

const config = testConfig();
const db = testPool(config);
const app: Express = buildTestApp(config, db);

let alice: TestUser;
let bob: TestUser;
let monitorId: string;

const checkSchema = z.strictObject({
  id: z.string(),
  monitorId: z.uuid(),
  status: z.enum(['success', 'failure']),
  httpStatus: z.number().int().nullable(),
  responseTimeMs: z.number().int(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});

const incidentSchema = z.strictObject({
  id: z.uuid(),
  monitorId: z.uuid(),
  status: z.enum(['open', 'resolved']),
  startedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  failureCount: z.number().int(),
});

const checksPageSchema = z.strictObject({
  checks: z.array(checkSchema),
  limit: z.number().int(),
  offset: z.number().int(),
});

const incidentsPageSchema = z.strictObject({
  incidents: z.array(incidentSchema),
  limit: z.number().int(),
  offset: z.number().int(),
});

const failure: ClassifiedCheck = {
  status: 'failure',
  httpStatus: 503,
  responseTimeMs: 40,
  errorType: 'status_mismatch',
  errorMessage: 'Expected status 200, received 503',
};

const success: ClassifiedCheck = {
  status: 'success',
  httpStatus: 200,
  responseTimeMs: 20,
  errorType: null,
  errorMessage: null,
};

async function createMonitor(user: TestUser): Promise<string> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      name: 'History subject',
      url: 'https://example.com/status',
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

  expect(response.status).toBe(201);

  return (response.body as { monitor: { id: string } }).monitor.id;
}

/** GET a path as `user`, with optional query string. */
function get(user: TestUser, path: string) {
  return request(app).get(path).set('Authorization', `Bearer ${user.token}`);
}

beforeAll(async () => {
  alice = await registerTestUser(app);
  bob = await registerTestUser(app);
});

beforeEach(async () => {
  await db.query('DELETE FROM monitors WHERE user_id = ANY($1)', [
    [alice.id, bob.id],
  ]);
  monitorId = await createMonitor(alice);
});

afterAll(async () => {
  await deleteTestUsers(db, [alice, bob]);
  await db.end();
});

describe('GET /api/monitors/:id/checks', () => {
  it('returns an empty page for a monitor with no history', async () => {
    const response = await get(alice, `/api/monitors/${monitorId}/checks`);

    expect(response.status).toBe(200);
    const page = checksPageSchema.parse(response.body);
    expect(page.checks).toEqual([]);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
  });

  it('returns stored checks newest first', async () => {
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, success);

    const response = await get(alice, `/api/monitors/${monitorId}/checks`);

    const { checks } = checksPageSchema.parse(response.body);
    expect(checks).toHaveLength(2);
    expect(checks[0]?.status).toBe('success');
    expect(checks[1]?.status).toBe('failure');
  });

  it('returns the documented check shape', async () => {
    await recordCheck(db, monitorId, failure);

    const response = await get(alice, `/api/monitors/${monitorId}/checks`);

    // The schema is strict, so an extra field would fail here. That matters:
    // this table is the one that holds attacker-influenced error text, and a
    // response body or a header must never appear in it.
    const { checks } = checksPageSchema.parse(response.body);
    expect(checks[0]).toMatchObject({
      monitorId,
      status: 'failure',
      httpStatus: 503,
      errorType: 'status_mismatch',
    });
  });

  it('honours limit and offset', async () => {
    for (let n = 0; n < 5; n += 1) await recordCheck(db, monitorId, failure);

    const first = await get(alice, `/api/monitors/${monitorId}/checks?limit=2`);
    const second = await get(
      alice,
      `/api/monitors/${monitorId}/checks?limit=2&offset=2`,
    );

    const firstPage = checksPageSchema.parse(first.body);
    const secondPage = checksPageSchema.parse(second.body);

    expect(firstPage.checks).toHaveLength(2);
    expect(secondPage.checks).toHaveLength(2);
    expect(firstPage.limit).toBe(2);
    expect(secondPage.offset).toBe(2);

    // Pages must not overlap. `checked_at` alone would not guarantee this —
    // several of these rows share a timestamp — which is why `id` breaks the
    // tie and the order is total.
    const ids = [
      ...firstPage.checks.map((check) => check.id),
      ...secondPage.checks.map((check) => check.id),
    ];
    expect(new Set(ids).size).toBe(4);
  });

  it('refuses an unbounded or nonsensical page', async () => {
    // Not clamped silently: a rejected parameter tells the client it sent
    // something wrong, where a quiet fallback hides the bug.
    for (const query of [
      'limit=100000',
      'limit=0',
      'limit=-1',
      'limit=abc',
      'offset=-1',
      'offset=999999999',
      'unknown=1',
    ]) {
      const response = await get(
        alice,
        `/api/monitors/${monitorId}/checks?${query}`,
      );

      expect(response.status).toBe(400);
    }
  });

  it('is a 404 for another user, exactly as the monitor itself is', async () => {
    await recordCheck(db, monitorId, failure);

    const response = await get(bob, `/api/monitors/${monitorId}/checks`);

    // Not 403: that would confirm the id exists, which is an enumeration
    // oracle over another account's monitors.
    expect(response.status).toBe(404);
  });

  it('is a 404 for a monitor that does not exist', async () => {
    const response = await get(
      alice,
      '/api/monitors/00000000-0000-0000-0000-000000000000/checks',
    );

    expect(response.status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await request(app).get(
      `/api/monitors/${monitorId}/checks`,
    );

    expect(response.status).toBe(401);
  });
});

describe('GET /api/monitors/:id/incidents', () => {
  /** Drive the monitor through one full outage and recovery. */
  async function oneIncident(): Promise<void> {
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, success);
  }

  it('returns an empty page for a healthy monitor', async () => {
    await recordCheck(db, monitorId, success);

    const response = await get(alice, `/api/monitors/${monitorId}/incidents`);

    expect(response.status).toBe(200);
    expect(incidentsPageSchema.parse(response.body).incidents).toEqual([]);
  });

  it('returns a resolved incident with both timestamps', async () => {
    await oneIncident();

    const response = await get(alice, `/api/monitors/${monitorId}/incidents`);

    const { incidents } = incidentsPageSchema.parse(response.body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      monitorId,
      status: 'resolved',
      failureCount: 3,
    });
    expect(incidents[0]?.resolvedAt).not.toBeNull();
  });

  it('reports an open incident with a null resolvedAt', async () => {
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);

    const response = await get(alice, `/api/monitors/${monitorId}/incidents`);

    const { incidents } = incidentsPageSchema.parse(response.body);
    expect(incidents[0]?.status).toBe('open');
    expect(incidents[0]?.resolvedAt).toBeNull();
  });

  it('returns incidents newest first', async () => {
    await oneIncident();
    await oneIncident();
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);

    const response = await get(alice, `/api/monitors/${monitorId}/incidents`);

    const { incidents } = incidentsPageSchema.parse(response.body);
    expect(incidents).toHaveLength(3);
    expect(incidents[0]?.status).toBe('open');
    expect(incidents[1]?.status).toBe('resolved');
    expect(incidents[2]?.status).toBe('resolved');
  });

  it('honours limit and offset', async () => {
    await oneIncident();
    await oneIncident();

    const response = await get(
      alice,
      `/api/monitors/${monitorId}/incidents?limit=1&offset=1`,
    );

    const page = incidentsPageSchema.parse(response.body);
    expect(page.incidents).toHaveLength(1);
    expect(page.offset).toBe(1);
  });

  it('refuses an unbounded page', async () => {
    const response = await get(
      alice,
      `/api/monitors/${monitorId}/incidents?limit=100000`,
    );

    expect(response.status).toBe(400);
  });

  it('is a 404 for another user', async () => {
    await oneIncident();

    const response = await get(bob, `/api/monitors/${monitorId}/incidents`);

    expect(response.status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await request(app).get(
      `/api/monitors/${monitorId}/incidents`,
    );

    expect(response.status).toBe(401);
  });
});
