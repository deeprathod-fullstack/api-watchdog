import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  findMonitorById,
  findMonitorForWorker,
} from '../src/monitors/repository.js';
import {
  buildTestApp,
  deleteTestUsers,
  registerTestUser,
  testConfig,
  testPool,
  type TestUser,
} from './helpers.js';

/**
 * The boundary between the two monitor lookups.
 *
 * There are exactly two ways to load a monitor, and they exist for different
 * callers:
 *
 *  - `findMonitorById(db, userId, id)` — every user-facing path. Ownership is a
 *    required argument, so it cannot be forgotten.
 *  - `findMonitorForWorker(db, id)` — the background worker only. No owner
 *    scope, because a scheduled job is made on nobody's behalf: there is no
 *    request, no token and no caller to authorise.
 *
 * The second is a deliberate exemption, and an exemption is only safe while it
 * stays where it was put. These tests pin all three halves of that: the scoped
 * lookup really is scoped, the worker lookup really does work by id alone, and
 * nothing in the request path can reach the worker lookup.
 */

const config = testConfig();
const db = testPool(config);
const app: Express = buildTestApp(config, db);

let alice: TestUser;
let bob: TestUser;
let aliceMonitorId: string;

async function createMonitor(user: TestUser): Promise<string> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      name: 'Boundary subject',
      url: 'https://example.com/status',
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

  expect(response.status).toBe(201);

  return (response.body as { monitor: { id: string } }).monitor.id;
}

beforeAll(async () => {
  alice = await registerTestUser(app);
  bob = await registerTestUser(app);
});

beforeEach(async () => {
  await db.query('DELETE FROM monitors WHERE user_id = ANY($1)', [
    [alice.id, bob.id],
  ]);
  aliceMonitorId = await createMonitor(alice);
});

afterAll(async () => {
  await deleteTestUsers(db, [alice, bob]);
  await db.end();
});

describe('findMonitorById is ownership-scoped', () => {
  it('returns the monitor to its owner', async () => {
    const monitor = await findMonitorById(db, alice.id, aliceMonitorId);

    expect(monitor?.id).toBe(aliceMonitorId);
    expect(monitor?.userId).toBe(alice.id);
  });

  it('returns null for another user, even with a valid id', async () => {
    // Not "returns it and the caller checks": nothing comes back at all, so
    // there is no row in memory for a later log line or early return to leak.
    const monitor = await findMonitorById(db, bob.id, aliceMonitorId);

    expect(monitor).toBeNull();
  });

  it('returns null for an id that does not exist', async () => {
    const monitor = await findMonitorById(
      db,
      alice.id,
      '00000000-0000-0000-0000-000000000000',
    );

    expect(monitor).toBeNull();
  });

  it('cannot be called without an owner', () => {
    // The real guarantee is in the type system: `userId` is a required
    // parameter, so there is no way to express an unscoped call. This asserts
    // the arity that enforces it, which is what a careless signature change
    // would break.
    expect(findMonitorById).toHaveLength(3);
  });
});

describe('findMonitorForWorker loads by id alone', () => {
  it('loads a monitor without being told who owns it', async () => {
    const monitor = await findMonitorForWorker(db, aliceMonitorId);

    expect(monitor?.id).toBe(aliceMonitorId);
    // The owner comes back on the row — the worker just never had to prove it.
    expect(monitor?.userId).toBe(alice.id);
  });

  it('loads the full configuration the check pipeline needs', async () => {
    const monitor = await findMonitorForWorker(db, aliceMonitorId);

    expect(monitor).toMatchObject({
      url: 'https://example.com/status',
      expectedStatus: 200,
      timeoutMs: 5000,
      intervalSeconds: 60,
      active: true,
    });
  });

  it('returns null for a monitor that has been deleted', async () => {
    await db.query('DELETE FROM monitors WHERE id = $1', [aliceMonitorId]);

    const monitor = await findMonitorForWorker(db, aliceMonitorId);

    expect(monitor).toBeNull();
  });
});

describe('the worker lookup is not reachable over HTTP', () => {
  /**
   * Every route that takes a monitor id.
   *
   * Exhaustive on purpose: the risk is not that one of these was written
   * wrongly today, it is that a route added later quietly uses the unscoped
   * lookup. Listing them all means a new route is either in this list or is
   * visibly missing from it.
   */
  const monitorRoutes: [
    method: 'get' | 'patch' | 'delete' | 'post',
    path: (id: string) => string,
  ][] = [
    ['get', (id) => `/api/monitors/${id}`],
    ['patch', (id) => `/api/monitors/${id}`],
    ['delete', (id) => `/api/monitors/${id}`],
    ['post', (id) => `/api/monitors/${id}/check`],
    ['get', (id) => `/api/monitors/${id}/checks`],
    ['get', (id) => `/api/monitors/${id}/incidents`],
  ];

  it.each(monitorRoutes)(
    '%s route answers 404 for another user',
    async (method, path) => {
      const attempt = request(app)[method](path(aliceMonitorId));
      const response = await attempt
        .set('Authorization', `Bearer ${bob.token}`)
        .send(method === 'patch' ? { name: 'Stolen' } : undefined);

      // 404 rather than 403 or 200: if any of these had been built on the
      // worker lookup, the row would be found and the response would differ.
      expect(response.status).toBe(404);
    },
  );

  it('leaves the monitor untouched after a cross-user attempt', async () => {
    await request(app)
      .patch(`/api/monitors/${aliceMonitorId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'Stolen', active: false });

    const monitor = await findMonitorById(db, alice.id, aliceMonitorId);
    expect(monitor?.name).toBe('Boundary subject');
    expect(monitor?.active).toBe(true);
  });

  it('never lists another user’s monitor on the dashboard', async () => {
    const response = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${bob.token}`);

    expect(response.status).toBe(200);
    const body = response.body as { monitors: { id: string }[] };
    expect(body.monitors.map((monitor) => monitor.id)).not.toContain(
      aliceMonitorId,
    );
  });
});

describe('the worker lookup stays out of the request path', () => {
  /**
   * The files allowed to name `findMonitorForWorker`.
   *
   * A structural test rather than a behavioural one, and the two do different
   * jobs. The behavioural tests above prove today's routes are scoped; this
   * proves the *next* route cannot quietly reach for the unscoped lookup. An
   * exemption is only safe while it stays where it was put, and a code review
   * is not a reliable place to keep it.
   */
  const ALLOWED = new Set([
    // Where it is defined.
    'monitors/repository.ts',
    // The one legitimate caller: the background check path.
    'checks/scheduled.ts',
  ]);

  const SRC = fileURLToPath(new URL('../src', import.meta.url));

  /** Every .ts file under src, as a path relative to src. */
  function sourceFiles(dir = SRC, prefix = ''): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        return sourceFiles(join(dir, entry.name), relative);
      }

      return entry.name.endsWith('.ts') ? [relative] : [];
    });
  }

  it('is referenced only by the repository that defines it and the worker path', () => {
    const offenders = sourceFiles().filter(
      (file) =>
        !ALLOWED.has(file) &&
        readFileSync(join(SRC, file), 'utf8').includes('findMonitorForWorker'),
    );

    expect(offenders).toEqual([]);
  });

  it('is not referenced by any router or by app wiring', () => {
    // Stated separately because this is the specific mistake worth naming: a
    // handler has a userId in hand and must use the scoped lookup.
    const requestPath = sourceFiles().filter(
      (file) =>
        file.endsWith('routes.ts') ||
        file === 'app.ts' ||
        file.startsWith('middleware/'),
    );

    // Guard the guard: if the glob ever stops matching the routers, this test
    // would pass vacuously.
    expect(requestPath.length).toBeGreaterThanOrEqual(4);

    for (const file of requestPath) {
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(source).not.toContain('findMonitorForWorker');
    }
  });

  it('sees the routers using the scoped lookup', () => {
    // The positive half: the monitors router really does call the scoped one,
    // so the assertions above are about a router that does monitor lookups at
    // all rather than one that happens to do none.
    const routes = readFileSync(join(SRC, 'monitors/routes.ts'), 'utf8');

    expect(routes).toContain('findMonitorById');
  });
});
