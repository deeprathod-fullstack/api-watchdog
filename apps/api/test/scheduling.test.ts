import type { Queue } from 'bullmq';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  BullMqScheduler,
  createChecksQueue,
  reconcileSchedules,
} from '../src/queue/checks-queue.js';
import { createRedisConnection } from '../src/queue/connection.js';
import {
  buildTestApp,
  deleteTestUsers,
  registerTestUser,
  testConfig,
  testPool,
  type TestUser,
} from './helpers.js';

/**
 * Scheduling against a real Redis and a real PostgreSQL.
 *
 * The property under test is a single sentence: **the set of job schedulers in
 * Redis equals the set of active monitors in PostgreSQL.** Every case below is
 * one way that could stop being true — create, pause, resume, edit the
 * interval, delete, restart the API, or lose Redis entirely.
 *
 * No worker runs here. These tests are about the schedule existing and having
 * the right period, not about a check being executed; execution is covered in
 * `worker.test.ts`. That separation is deliberate — a test that waits for a job
 * to fire is a test that waits, and a slow suite gets skipped.
 */

const config = testConfig();
const db = testPool(config);

let redis: Redis;
let queue: Queue;
let app: Express;
let owner: TestUser;

/** What the scheduler holds for one monitor: its period in ms, or nothing. */
async function scheduleFor(monitorId: string): Promise<number | undefined> {
  const scheduler = await queue.getJobScheduler(monitorId);

  if (scheduler === null || scheduler === undefined) return undefined;

  return scheduler.every === undefined || scheduler.every === null
    ? undefined
    : Number(scheduler.every);
}

/** Every scheduler key currently in the queue. */
async function scheduleKeys(): Promise<string[]> {
  const schedulers = await queue.getJobSchedulers(0, -1, true);

  return schedulers.map((scheduler) => scheduler.key).sort();
}

const validMonitor = {
  name: 'Scheduled monitor',
  url: 'https://example.com/status',
  intervalSeconds: 60,
  timeoutMs: 5000,
};

async function createMonitor(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ ...validMonitor, ...overrides });

  expect(response.status).toBe(201);

  return (response.body as { monitor: { id: string } }).monitor.id;
}

async function patchMonitor(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await request(app)
    .patch(`/api/monitors/${id}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send(patch);

  expect(response.status).toBe(200);
}

beforeAll(async () => {
  redis = createRedisConnection(config);
  queue = createChecksQueue(redis);
  app = buildTestApp(config, db, { scheduler: new BullMqScheduler(queue) });
  owner = await registerTestUser(app);
});

// Each test starts from an empty account and an empty queue, so one test's
// leftovers can never be mistaken for another's behaviour.
beforeEach(async () => {
  await db.query('DELETE FROM monitors WHERE user_id = $1', [owner.id]);
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
  await deleteTestUsers(db, [owner]);
  await db.end();
});

describe('monitor writes keep the schedule in step', () => {
  it('schedules a monitor created active', async () => {
    const id = await createMonitor({ intervalSeconds: 60 });

    expect(await scheduleFor(id)).toBe(60_000);
  });

  it('does not schedule a monitor created paused', async () => {
    const id = await createMonitor({ active: false });

    expect(await scheduleFor(id)).toBeUndefined();
    expect(await scheduleKeys()).toEqual([]);
  });

  it('removes the schedule when a monitor is paused', async () => {
    const id = await createMonitor();
    expect(await scheduleFor(id)).toBe(60_000);

    await patchMonitor(id, { active: false });

    expect(await scheduleFor(id)).toBeUndefined();
  });

  it('restores the schedule when a paused monitor is resumed', async () => {
    const id = await createMonitor({ active: false, intervalSeconds: 120 });
    expect(await scheduleFor(id)).toBeUndefined();

    await patchMonitor(id, { active: true });

    // The interval comes from the stored row, not from the patch.
    expect(await scheduleFor(id)).toBe(120_000);
  });

  it('updates the period when the interval changes', async () => {
    const id = await createMonitor({ intervalSeconds: 60 });

    await patchMonitor(id, { intervalSeconds: 300 });

    expect(await scheduleFor(id)).toBe(300_000);
    // The old period must not survive alongside the new one. Addressing the
    // scheduler by monitor id is what guarantees this: an interval change
    // updates the one entry rather than adding a second.
    expect(await scheduleKeys()).toEqual([id]);
  });

  it('leaves a paused monitor unscheduled when its interval changes', async () => {
    const id = await createMonitor({ active: false });

    await patchMonitor(id, { intervalSeconds: 300 });

    expect(await scheduleFor(id)).toBeUndefined();
  });

  it('removes the schedule when a monitor is deleted', async () => {
    const id = await createMonitor();

    const response = await request(app)
      .delete(`/api/monitors/${id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(response.status).toBe(204);

    expect(await scheduleFor(id)).toBeUndefined();
    expect(await scheduleKeys()).toEqual([]);
  });

  it('does not disturb the schedule on an unrelated edit', async () => {
    // An upsert restarts the timer, so re-syncing on a rename would push the
    // next check up to a full interval away. A rename must not delay a check.
    const id = await createMonitor();
    const before = await queue.getJobScheduler(id);

    await patchMonitor(id, { name: 'Renamed' });

    const after = await queue.getJobScheduler(id);
    expect(after?.next).toBe(before?.next);
  });

  it('needs no schedule change for URL, timeout or expected status', async () => {
    // These reach the worker through PostgreSQL, not through the job payload,
    // so there is nothing in Redis to update.
    const id = await createMonitor();
    const before = await queue.getJobScheduler(id);

    await patchMonitor(id, {
      url: 'https://another.example/health',
      timeoutMs: 9000,
      expectedStatus: 204,
    });

    const after = await queue.getJobScheduler(id);
    expect(after?.next).toBe(before?.next);
    expect(after?.every).toBe(before?.every);
  });
});

describe('scheduling is idempotent', () => {
  it('produces one schedule however many times a monitor is synced', async () => {
    const id = await createMonitor();
    const scheduler = new BullMqScheduler(queue);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await scheduler.sync({ id, intervalSeconds: 60, active: true });
    }

    expect(await scheduleKeys()).toEqual([id]);
  });

  it('treats removing an absent schedule as a success', async () => {
    const scheduler = new BullMqScheduler(queue);

    await expect(
      scheduler.remove('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });

  it('treats pausing an already paused monitor as a success', async () => {
    const scheduler = new BullMqScheduler(queue);

    await scheduler.sync({ id: 'absent', intervalSeconds: 60, active: false });

    expect(await scheduleKeys()).toEqual([]);
  });
});

describe('startup reconciliation', () => {
  it('rebuilds every active monitor schedule after Redis is lost', async () => {
    const first = await createMonitor({ intervalSeconds: 60 });
    const second = await createMonitor({
      name: 'Second',
      intervalSeconds: 300,
    });
    await createMonitor({ name: 'Paused', active: false });

    // Simulate exactly what a Redis restart or a FLUSHALL does to us.
    await queue.obliterate({ force: true });
    expect(await scheduleKeys()).toEqual([]);

    const report = await reconcileSchedules(db, queue);

    expect(report).toEqual({ added: 2, removed: 0, unchanged: 0 });
    expect(await scheduleKeys()).toEqual([first, second].sort());
    expect(await scheduleFor(first)).toBe(60_000);
    expect(await scheduleFor(second)).toBe(300_000);
  });

  it('removes schedules whose monitor is gone', async () => {
    const scheduler = new BullMqScheduler(queue);
    // A schedule with no monitor behind it: what a failed removal during a
    // delete would leave. Harmless — the worker reloads from PostgreSQL and
    // finds nothing — but it should not survive a restart.
    await scheduler.sync({
      id: '11111111-1111-1111-1111-111111111111',
      intervalSeconds: 60,
      active: true,
    });

    const report = await reconcileSchedules(db, queue);

    expect(report.removed).toBe(1);
    expect(await scheduleKeys()).toEqual([]);
  });

  it('removes the schedule of a monitor paused while Redis was unreachable', async () => {
    const id = await createMonitor();
    // The row says paused; Redis was never told.
    await db.query('UPDATE monitors SET active = false WHERE id = $1', [id]);

    const report = await reconcileSchedules(db, queue);

    expect(report).toEqual({ added: 0, removed: 1, unchanged: 0 });
    expect(await scheduleFor(id)).toBeUndefined();
  });

  it('corrects a schedule whose interval drifted from the row', async () => {
    const id = await createMonitor({ intervalSeconds: 60 });
    await db.query('UPDATE monitors SET interval_seconds = 300 WHERE id = $1', [
      id,
    ]);

    const report = await reconcileSchedules(db, queue);

    expect(report).toEqual({ added: 1, removed: 0, unchanged: 0 });
    expect(await scheduleFor(id)).toBe(300_000);
  });

  it('creates no duplicates when the API restarts repeatedly', async () => {
    const id = await createMonitor();

    for (let restart = 0; restart < 3; restart += 1) {
      await reconcileSchedules(db, queue);
    }

    expect(await scheduleKeys()).toEqual([id]);
  });

  it('leaves a correct schedule completely untouched', async () => {
    // Reconciliation must not restart timers it did not need to change, or
    // every deploy would delay every check by up to one full interval.
    const id = await createMonitor();
    const before = await queue.getJobScheduler(id);

    const report = await reconcileSchedules(db, queue);

    expect(report).toEqual({ added: 0, removed: 0, unchanged: 1 });
    const after = await queue.getJobScheduler(id);
    expect(after?.next).toBe(before?.next);
  });

  it('is a no-op against an empty database and an empty queue', async () => {
    const report = await reconcileSchedules(db, queue);

    expect(report).toEqual({ added: 0, removed: 0, unchanged: 0 });
  });
});
