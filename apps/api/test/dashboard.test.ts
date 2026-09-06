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
 * GET /api/dashboard.
 *
 * The endpoint every page view hits, so the two properties that matter are
 * that it reports the truth and that it reports only this user's truth.
 */

const config = testConfig();
const db = testPool(config);
const app: Express = buildTestApp(config, db);

let alice: TestUser;
let bob: TestUser;

const dashboardSchema = z.strictObject({
  summary: z.strictObject({
    total: z.number().int(),
    active: z.number().int(),
    healthy: z.number().int(),
    failing: z.number().int(),
    unknown: z.number().int(),
    openIncidents: z.number().int(),
  }),
  monitors: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      url: z.string(),
      active: z.boolean(),
      expectedStatus: z.number().int(),
      intervalSeconds: z.number().int(),
      timeoutMs: z.number().int(),
      latestStatus: z.enum(['success', 'failure']).nullable(),
      latestHttpStatus: z.number().int().nullable(),
      latestResponseTimeMs: z.number().int().nullable(),
      latestCheckedAt: z.iso.datetime().nullable(),
      incidentOpen: z.boolean(),
    }),
  ),
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
  responseTimeMs: 21,
  errorType: null,
  errorMessage: null,
};

async function createMonitor(
  user: TestUser,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      name: 'Dashboard subject',
      url: 'https://example.com/status',
      intervalSeconds: 60,
      timeoutMs: 5000,
      ...overrides,
    });

  expect(response.status).toBe(201);

  return (response.body as { monitor: { id: string } }).monitor.id;
}

async function dashboard(user: TestUser) {
  const response = await request(app)
    .get('/api/dashboard')
    .set('Authorization', `Bearer ${user.token}`);

  expect(response.status).toBe(200);

  return dashboardSchema.parse(response.body);
}

beforeAll(async () => {
  alice = await registerTestUser(app);
  bob = await registerTestUser(app);
});

beforeEach(async () => {
  await db.query('DELETE FROM monitors WHERE user_id = ANY($1)', [
    [alice.id, bob.id],
  ]);
});

afterAll(async () => {
  await deleteTestUsers(db, [alice, bob]);
  await db.end();
});

describe('GET /api/dashboard', () => {
  it('reports an empty dashboard for a new account', async () => {
    const { summary, monitors } = await dashboard(alice);

    expect(monitors).toEqual([]);
    expect(summary).toEqual({
      total: 0,
      active: 0,
      healthy: 0,
      failing: 0,
      unknown: 0,
      openIncidents: 0,
    });
  });

  it('counts a monitor that has never been checked as unknown', async () => {
    await createMonitor(alice);

    const { summary, monitors } = await dashboard(alice);

    expect(summary).toMatchObject({ total: 1, active: 1, unknown: 1 });
    // Present in the list, not dropped: "never checked" is a state to show.
    expect(monitors[0]?.latestStatus).toBeNull();
    expect(monitors[0]?.latestCheckedAt).toBeNull();
    expect(monitors[0]?.latestHttpStatus).toBeNull();
  });

  it('reports the latest check, not an older one', async () => {
    const id = await createMonitor(alice);
    await recordCheck(db, id, failure);
    await recordCheck(db, id, success);

    const { summary, monitors } = await dashboard(alice);

    expect(summary).toMatchObject({ healthy: 1, failing: 0, unknown: 0 });
    expect(monitors[0]).toMatchObject({
      latestStatus: 'success',
      latestHttpStatus: 200,
      latestResponseTimeMs: 21,
    });
    expect(monitors[0]?.latestCheckedAt).not.toBeNull();
  });

  it('counts a failing monitor as failing', async () => {
    const id = await createMonitor(alice);
    await recordCheck(db, id, failure);

    const { summary } = await dashboard(alice);

    expect(summary).toMatchObject({ healthy: 0, failing: 1, unknown: 0 });
  });

  it('reports an open incident against its monitor', async () => {
    const id = await createMonitor(alice);
    for (let n = 0; n < 3; n += 1) await recordCheck(db, id, failure);

    const { summary, monitors } = await dashboard(alice);

    expect(summary.openIncidents).toBe(1);
    expect(monitors[0]?.incidentOpen).toBe(true);
  });

  it('stops reporting an incident once it is resolved', async () => {
    const id = await createMonitor(alice);
    for (let n = 0; n < 3; n += 1) await recordCheck(db, id, failure);
    await recordCheck(db, id, success);

    const { summary, monitors } = await dashboard(alice);

    expect(summary.openIncidents).toBe(0);
    expect(monitors[0]?.incidentOpen).toBe(false);
    expect(monitors[0]?.latestStatus).toBe('success');
  });

  it('keeps a paused monitor with its last known result', async () => {
    // Health and activity are orthogonal. Pausing stops us checking; it does
    // not make the last thing we saw untrue, and a monitor paused *because* it
    // was failing must still say so.
    const id = await createMonitor(alice);
    await recordCheck(db, id, failure);
    await request(app)
      .patch(`/api/monitors/${id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ active: false });

    const { summary, monitors } = await dashboard(alice);

    expect(summary).toMatchObject({ total: 1, active: 0, failing: 1 });
    expect(monitors[0]?.active).toBe(false);
    expect(monitors[0]?.latestStatus).toBe('failure');
  });

  it('adds the health counts up to the total', async () => {
    const healthy = await createMonitor(alice, { name: 'Healthy' });
    const failing = await createMonitor(alice, { name: 'Failing' });
    await createMonitor(alice, { name: 'Never checked' });
    await createMonitor(alice, { name: 'Paused', active: false });

    await recordCheck(db, healthy, success);
    await recordCheck(db, failing, failure);

    const { summary } = await dashboard(alice);

    expect(summary).toEqual({
      total: 4,
      active: 3,
      healthy: 1,
      failing: 1,
      unknown: 2,
      openIncidents: 0,
    });
    expect(summary.healthy + summary.failing + summary.unknown).toBe(
      summary.total,
    );
  });

  it('lists monitors newest first', async () => {
    await createMonitor(alice, { name: 'First' });
    await createMonitor(alice, { name: 'Second' });

    const { monitors } = await dashboard(alice);

    expect(monitors.map((monitor) => monitor.name)).toEqual([
      'Second',
      'First',
    ]);
  });

  it('shows one row per monitor even with a long history', async () => {
    // The lateral join takes the newest check per monitor. If it were an
    // ordinary join, this monitor would appear five times.
    const id = await createMonitor(alice);
    for (let n = 0; n < 5; n += 1) await recordCheck(db, id, failure);

    const { monitors, summary } = await dashboard(alice);

    expect(monitors).toHaveLength(1);
    expect(summary.total).toBe(1);
  });

  it('never shows another user their neighbour data', async () => {
    const aliceMonitor = await createMonitor(alice, { name: "Alice's" });
    await recordCheck(db, aliceMonitor, failure);
    await createMonitor(bob, { name: "Bob's" });

    const bobView = await dashboard(bob);

    expect(bobView.summary).toMatchObject({ total: 1, unknown: 1 });
    expect(bobView.monitors.map((monitor) => monitor.name)).toEqual(["Bob's"]);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await request(app).get('/api/dashboard');

    expect(response.status).toBe(401);
  });

  it('does not expose headers or any other monitor internals', async () => {
    // The strict schema above is the real assertion; this makes the intent
    // explicit. Monitor headers are user-supplied and belong in exactly one
    // response — the monitor's own — and not in a bulk view.
    const id = await createMonitor(alice, {
      headers: { 'X-Watchdog': 'sentinel' },
    });
    await recordCheck(db, id, success);

    const response = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${alice.token}`);

    expect(JSON.stringify(response.body)).not.toContain('sentinel');
  });
});
