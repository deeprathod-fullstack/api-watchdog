import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ClassifiedCheck } from '../src/checks/classify.js';
import {
  DEFAULT_FAILURE_THRESHOLD,
  recordCheck,
} from '../src/incidents/engine.js';
import {
  currentFailureStreak,
  type Incident,
} from '../src/incidents/repository.js';
import {
  buildTestApp,
  deleteTestUsers,
  registerTestUser,
  testConfig,
  testPool,
  type TestUser,
} from './helpers.js';

/**
 * The incident engine against real PostgreSQL.
 *
 * Tested directly rather than through the worker, because what is being pinned
 * here is a state machine over `check_results`, and driving it through sockets
 * and a queue would only add ways for a test to fail for reasons unrelated to
 * the rule it is checking.
 *
 * The rules, all of which are V1 decisions and none of which are incidental:
 *
 *  - an incident opens on the Nth consecutive failure (default 3)
 *  - `started_at` is the first failure of the streak, not the Nth
 *  - `failure_count` is the whole streak, including the failures before N
 *  - one open incident per monitor, ever
 *  - one success resolves it, and resolution is terminal
 *  - a later streak opens a new incident
 */

const config = testConfig();
const db = testPool(config);
const app: Express = buildTestApp(config, db);

let owner: TestUser;
let monitorId: string;

const failure: ClassifiedCheck = {
  status: 'failure',
  httpStatus: null,
  responseTimeMs: 12,
  errorType: 'timeout',
  errorMessage: 'Timed out after 5000 ms',
};

const success: ClassifiedCheck = {
  status: 'success',
  httpStatus: 200,
  responseTimeMs: 34,
  errorType: null,
  errorMessage: null,
};

/** Create a monitor owned by `owner` and return its id. */
async function createMonitor(): Promise<string> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({
      name: 'Incident subject',
      url: 'https://example.com/status',
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

  expect(response.status).toBe(201);

  return (response.body as { monitor: { id: string } }).monitor.id;
}

/** The monitor's incidents, oldest first. */
async function incidents(id = monitorId): Promise<Incident[]> {
  const result = await db.query<{
    id: string;
    status: string;
    started_at: Date;
    resolved_at: Date | null;
    failure_count: number;
  }>(
    `SELECT id, status, started_at, resolved_at, failure_count
       FROM incidents WHERE monitor_id = $1 ORDER BY started_at, id`,
    [id],
  );

  return result.rows.map((row) => ({
    id: row.id,
    monitorId: id,
    status: row.status === 'open' ? 'open' : 'resolved',
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    failureCount: row.failure_count,
  }));
}

beforeAll(async () => {
  owner = await registerTestUser(app);
});

beforeEach(async () => {
  // A fresh monitor per test: check_results and incidents cascade away with
  // the old one, so no test inherits another's streak.
  await db.query('DELETE FROM monitors WHERE user_id = $1', [owner.id]);
  monitorId = await createMonitor();
});

afterAll(async () => {
  await deleteTestUsers(db, [owner]);
  await db.end();
});

describe('opening an incident', () => {
  it('records the first failure without opening an incident', async () => {
    const { transition } = await recordCheck(db, monitorId, failure);

    expect(transition.kind).toBe('none');
    expect(await incidents()).toHaveLength(0);
  });

  it('still opens nothing on the second failure', async () => {
    await recordCheck(db, monitorId, failure);
    const { transition } = await recordCheck(db, monitorId, failure);

    expect(transition.kind).toBe('none');
    expect(await incidents()).toHaveLength(0);
  });

  it('opens an incident on the third consecutive failure', async () => {
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, failure);
    const { transition } = await recordCheck(db, monitorId, failure);

    expect(transition.kind).toBe('opened');

    const open = await incidents();
    expect(open).toHaveLength(1);
    expect(open[0]?.status).toBe('open');
    expect(open[0]?.resolvedAt).toBeNull();
  });

  it('dates the incident from the first failure, not the third', async () => {
    const first = await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, failure);
    const third = await recordCheck(db, monitorId, failure);

    const [incident] = await incidents();

    // The outage began when the monitor first stopped answering. Dating it
    // from the threshold would under-report every outage by two intervals.
    expect(incident?.startedAt.getTime()).toBe(first.check.checkedAt.getTime());
    expect(incident?.startedAt.getTime()).toBeLessThanOrEqual(
      third.check.checkedAt.getTime(),
    );
  });

  it('counts the whole streak, including the failures before the threshold', async () => {
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, failure);

    expect((await incidents())[0]?.failureCount).toBe(3);
  });

  it('grows the same incident on the fourth failure', async () => {
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);
    const openedId = (await incidents())[0]?.id;

    const { transition } = await recordCheck(db, monitorId, failure);

    expect(transition.kind).toBe('ongoing');

    const all = await incidents();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(openedId);
    expect(all[0]?.failureCount).toBe(4);
  });

  it('keeps counting through a long outage without opening a second', async () => {
    for (let n = 0; n < 10; n += 1) await recordCheck(db, monitorId, failure);

    const all = await incidents();
    expect(all).toHaveLength(1);
    expect(all[0]?.failureCount).toBe(10);
  });

  it('honours a threshold other than the default', async () => {
    // The threshold being a parameter is the point: this is the same engine,
    // told a different policy.
    const { transition } = await recordCheck(db, monitorId, failure, 1);

    expect(transition.kind).toBe('opened');
    expect((await incidents())[0]?.failureCount).toBe(1);
  });

  it('defaults the threshold to three', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(3);
  });
});

describe('resolving an incident', () => {
  it('resolves an open incident on the first success', async () => {
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);

    const recovery = await recordCheck(db, monitorId, success);

    expect(recovery.transition.kind).toBe('resolved');

    const [incident] = await incidents();
    expect(incident?.status).toBe('resolved');
    // The recovery check's own instant, so "how long was it down" is exactly
    // resolved_at - started_at.
    expect(incident?.resolvedAt?.getTime()).toBe(
      recovery.check.checkedAt.getTime(),
    );
  });

  it('reports no transition when a success finds nothing open', async () => {
    const { transition } = await recordCheck(db, monitorId, success);

    expect(transition.kind).toBe('none');
    expect(await incidents()).toHaveLength(0);
  });

  it('does not resolve anything when the streak never reached the threshold', async () => {
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, failure);

    const { transition } = await recordCheck(db, monitorId, success);

    expect(transition.kind).toBe('none');
    expect(await incidents()).toHaveLength(0);
  });

  it('leaves a resolved incident alone on later successes', async () => {
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);
    const recovery = await recordCheck(db, monitorId, success);
    const resolvedAt = (await incidents())[0]?.resolvedAt;

    await recordCheck(db, monitorId, success);
    await recordCheck(db, monitorId, success);

    const all = await incidents();
    expect(all).toHaveLength(1);
    // Resolution is terminal: the timestamp is the moment of recovery, not
    // the moment of the most recent healthy check.
    expect(all[0]?.resolvedAt?.getTime()).toBe(resolvedAt?.getTime());
    expect(recovery.transition.kind).toBe('resolved');
  });

  it('opens a new incident for a later streak instead of reviving the old one', async () => {
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, success);
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);

    const all = await incidents();
    expect(all).toHaveLength(2);
    expect(all[0]?.status).toBe('resolved');
    expect(all[1]?.status).toBe('open');
    // The new streak is counted from the success, not from the beginning of
    // time: three failures, not six.
    expect(all[1]?.failureCount).toBe(3);
  });

  it('starts the streak over after any success', async () => {
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, success);
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, failure);

    // Four failures on record, but only two of them consecutive.
    const streak = await currentFailureStreak(db, monitorId);
    expect(streak.failures).toBe(2);
    expect(await incidents()).toHaveLength(0);
  });
});

describe('concurrency', () => {
  it('opens exactly one incident when two workers cross the threshold together', async () => {
    // Two failures already on record, so both of the concurrent checks below
    // see a streak that reaches the threshold. Without the partial unique
    // index and ON CONFLICT, both would insert and the monitor would have two
    // open incidents — which is the state every uptime figure assumes is
    // impossible.
    await recordCheck(db, monitorId, failure);
    await recordCheck(db, monitorId, failure);

    const results = await Promise.all([
      recordCheck(db, monitorId, failure),
      recordCheck(db, monitorId, failure),
    ]);

    const all = await incidents();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('open');

    // One of them opened it; the other found it already open.
    const kinds = results.map((result) => result.transition.kind).sort();
    expect(kinds).toEqual(['ongoing', 'opened']);
  });

  it('opens one incident under a burst of simultaneous failures', async () => {
    const attempts = Array.from({ length: 8 }, () =>
      recordCheck(db, monitorId, failure),
    );
    await Promise.all(attempts);

    const all = await incidents();
    expect(all).toHaveLength(1);
    // Every attempt was recorded, whatever order they committed in.
    const stored = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM check_results WHERE monitor_id = $1',
      [monitorId],
    );
    expect(Number(stored.rows[0]?.count)).toBe(8);
  });

  it('cannot be made to hold two open incidents at once', async () => {
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);

    // The final invariant, asserted against the database rather than the
    // application: the index is what makes this impossible, so bypassing the
    // engine entirely is the honest way to test it.
    await expect(
      db.query(
        `INSERT INTO incidents (monitor_id, status, started_at, failure_count)
              VALUES ($1, 'open', now(), 1)`,
        [monitorId],
      ),
    ).rejects.toThrow();
  });
});

describe('durability', () => {
  it('writes the check and the incident together or not at all', async () => {
    // A check for a monitor that no longer exists violates the foreign key, so
    // the whole transaction must roll back — leaving no check row behind.
    await db.query('DELETE FROM monitors WHERE id = $1', [monitorId]);

    await expect(recordCheck(db, monitorId, failure)).rejects.toThrow();

    const stored = await db.query(
      'SELECT 1 FROM check_results WHERE monitor_id = $1',
      [monitorId],
    );
    expect(stored.rowCount).toBe(0);
  });

  it('returns the pooled connection after a failed transaction', async () => {
    await db.query('DELETE FROM monitors WHERE id = $1', [monitorId]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(recordCheck(db, monitorId, failure)).rejects.toThrow();
    }

    // A transaction left open would hold its connection and its locks, and the
    // next caller would inherit an aborted transaction. This query proves the
    // pool is still usable.
    const alive = await db.query<{ ok: number }>('SELECT 1 AS ok');
    expect(alive.rows[0]?.ok).toBe(1);
  });

  it('removes incidents and checks when the monitor is deleted', async () => {
    for (let n = 0; n < 3; n += 1) await recordCheck(db, monitorId, failure);
    expect(await incidents()).toHaveLength(1);

    await db.query('DELETE FROM monitors WHERE id = $1', [monitorId]);

    expect(await incidents()).toHaveLength(0);
    const checks = await db.query(
      'SELECT 1 FROM check_results WHERE monitor_id = $1',
      [monitorId],
    );
    expect(checks.rowCount).toBe(0);
  });
});

describe('failure streaks', () => {
  it('counts the entire history of a monitor that has never succeeded', async () => {
    const pool: pg.Pool = db;
    await recordCheck(pool, monitorId, failure);
    await recordCheck(pool, monitorId, failure);

    const streak = await currentFailureStreak(pool, monitorId);

    expect(streak.failures).toBe(2);
    expect(streak.firstFailureAt).not.toBeNull();
  });

  it('reports an empty streak for a monitor with no checks', async () => {
    const streak = await currentFailureStreak(db, monitorId);

    expect(streak).toEqual({ failures: 0, firstFailureAt: null });
  });
});
