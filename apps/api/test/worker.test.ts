import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Worker, type Queue } from 'bullmq';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { createCheckClient, type UrlGuard } from '../src/checks/http-client.js';
import type { ResolvedAddress } from '../src/checks/safe-lookup.js';
import { runScheduledCheck } from '../src/checks/scheduled.js';
import type { CheckExecutor } from '../src/checks/service.js';
import { guardUrl } from '../src/checks/url-guard.js';
import {
  BullMqScheduler,
  CHECK_JOB_NAME,
  CHECKS_QUEUE_NAME,
  type CheckJobData,
  createChecksQueue,
} from '../src/queue/checks-queue.js';
import { createRedisConnection } from '../src/queue/connection.js';
import {
  buildTestApp,
  deleteTestUsers,
  registerTestUser,
  testConfig,
  testPool,
  TEST_QUEUE_PREFIX,
  type TestUser,
} from './helpers.js';

/**
 * The background check path, against real PostgreSQL, real Redis and real
 * sockets.
 *
 * Two layers are tested, deliberately separately:
 *
 *  - `runScheduledCheck` — the decisions. Reload the monitor, refuse to check a
 *    deleted or paused one, run the shared pipeline, store the result, move the
 *    incident. No queue involved, so these are fast and cannot flake on timing.
 *  - a real BullMQ `Worker` — the plumbing. One test, to prove a job placed on
 *    the queue reaches the processor and that a graceful close waits for it.
 *
 * The SSRF policy is not relaxed anywhere here. Monitors point at
 * `monitor.test`, a reserved TLD that cannot resolve, and reaching the local
 * server is possible only through an explicitly pinned loopback address. The
 * only injected seam is the static guard's port rule, because a test server
 * necessarily listens on an ephemeral port — exactly the seam the manual-check
 * tests already use.
 */

const config = testConfig();
const db = testPool(config);

let redis: Redis;
let queue: Queue;
let app: Express;
let owner: TestUser;

const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };

interface TestServer {
  port: number;
  received: IncomingHttpHeaders[];
  close: () => Promise<void>;
}

const servers: TestServer[] = [];
const testPorts = new Set<number>();

async function startServer(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
): Promise<TestServer> {
  const received: IncomingHttpHeaders[] = [];

  const server = http.createServer((request_, response) => {
    received.push(request_.headers);
    handler(request_, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  testPorts.add(port);

  const instance: TestServer = {
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };

  servers.push(instance);

  return instance;
}

/**
 * The real static guard, with one exception: a `monitor.test` URL on a port a
 * test server is actually listening on is allowed through.
 *
 * Nothing else is relaxed. Scheme, credentials and IP-literal rules are the
 * production ones, and the port must be a port this file opened.
 */
const testGuard: UrlGuard = (url) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return guardUrl(url);
  }

  const port = Number(parsed.port);
  if (
    parsed.protocol === 'http:' &&
    parsed.hostname === 'monitor.test' &&
    testPorts.has(port)
  ) {
    return {
      ok: true,
      target: {
        url: parsed.href,
        hostname: parsed.hostname,
        port,
        isIpLiteral: false,
      },
    };
  }

  return guardUrl(url);
};

/** A resolver that answers only for `monitor.test`, and only with loopback. */
const testResolve = (hostname: string) =>
  Promise.resolve(
    hostname === 'monitor.test'
      ? ({ ok: true, addresses: [LOOPBACK] } as const)
      : ({ ok: false, reason: 'dns' } as const),
  );

const testExecutor: CheckExecutor = {
  guard: testGuard,
  resolve: testResolve,
  client: createCheckClient({ resolve: testResolve, guard: testGuard }),
};

/** Create a monitor, then point it at `url` directly. See manual-check.test.ts. */
async function createMonitor(
  url: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({
      name: 'Scheduled target',
      url: 'http://monitor.test/',
      intervalSeconds: 60,
      timeoutMs: 5000,
      ...overrides,
    });

  expect(response.status).toBe(201);

  const id = (response.body as { monitor: { id: string } }).monitor.id;
  await db.query('UPDATE monitors SET url = $1 WHERE id = $2', [url, id]);

  return id;
}

/** The stored check results for a monitor, oldest first. */
async function storedChecks(monitorId: string) {
  const result = await db.query<{
    status: string;
    http_status: number | null;
    error_type: string | null;
  }>(
    `SELECT status, http_status, error_type
       FROM check_results WHERE monitor_id = $1 ORDER BY id`,
    [monitorId],
  );

  return result.rows;
}

beforeAll(async () => {
  redis = createRedisConnection(config);
  queue = createChecksQueue(redis, TEST_QUEUE_PREFIX);
  app = buildTestApp(config, db, { scheduler: new BullMqScheduler(queue) });
  owner = await registerTestUser(app);
});

beforeEach(async () => {
  await db.query('DELETE FROM monitors WHERE user_id = $1', [owner.id]);
  await queue.obliterate({ force: true });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
  await deleteTestUsers(db, [owner]);
  await db.end();
});

describe('runScheduledCheck', () => {
  it('checks a healthy monitor and stores a success', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end('ok');
    });
    const id = await createMonitor(
      `http://monitor.test:${String(server.port)}/`,
    );

    const outcome = await runScheduledCheck(db, testExecutor, id);

    expect(outcome).toEqual({
      kind: 'checked',
      status: 'success',
      incident: 'none',
    });

    const checks = await storedChecks(id);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('success');
    expect(checks[0]?.http_status).toBe(200);
  });

  it('stores a failure when the status does not match', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(500).end('boom');
    });
    const id = await createMonitor(
      `http://monitor.test:${String(server.port)}/`,
    );

    const outcome = await runScheduledCheck(db, testExecutor, id);

    expect(outcome).toMatchObject({ kind: 'checked', status: 'failure' });
    expect((await storedChecks(id))[0]?.error_type).toBe('status_mismatch');
  });

  it('sends the monitor headers it was configured with', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end('ok');
    });
    const id = await createMonitor(
      `http://monitor.test:${String(server.port)}/`,
      { headers: { 'X-Watchdog': 'yes' } },
    );

    await runScheduledCheck(db, testExecutor, id);

    expect(server.received[0]?.['x-watchdog']).toBe('yes');
  });

  it('does nothing for a monitor that no longer exists', async () => {
    const id = await createMonitor('http://monitor.test/');
    await db.query('DELETE FROM monitors WHERE id = $1', [id]);

    const outcome = await runScheduledCheck(db, testExecutor, id);

    expect(outcome).toEqual({ kind: 'gone' });
    expect(await storedChecks(id)).toHaveLength(0);
  });

  it('does nothing for a monitor that has been paused', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end('ok');
    });
    const id = await createMonitor(
      `http://monitor.test:${String(server.port)}/`,
      { active: false },
    );

    const outcome = await runScheduledCheck(db, testExecutor, id);

    expect(outcome).toEqual({ kind: 'paused' });
    // The important half: no outbound request was made either.
    expect(server.received).toHaveLength(0);
    expect(await storedChecks(id)).toHaveLength(0);
  });

  it('uses the current row, not the settings the job was queued with', async () => {
    // A job holds only a monitor id, so an edit between queueing and execution
    // takes effect immediately. This is the property that makes that true.
    const server = await startServer((_request, response) => {
      response.writeHead(500).end('boom');
    });
    const id = await createMonitor(
      `http://monitor.test:${String(server.port)}/`,
    );

    await db.query('UPDATE monitors SET expected_status = 500 WHERE id = $1', [
      id,
    ]);

    const outcome = await runScheduledCheck(db, testExecutor, id);

    // 500 is now the expected status, so the same response is a success.
    expect(outcome).toMatchObject({ status: 'success' });
  });

  it('applies the SSRF gate to a monitor pointed at a blocked address', async () => {
    // The row is written directly, exactly as an attacker would need CRUD to
    // let them do. The check pipeline refuses it anyway, which is the whole
    // point of the guard being at fetch time and not only at write time.
    const id = await createMonitor('http://169.254.169.254/latest/meta-data/');

    const outcome = await runScheduledCheck(db, testExecutor, id);

    expect(outcome).toMatchObject({ status: 'failure' });
    expect((await storedChecks(id))[0]?.error_type).toBe('blocked_address');
  });

  it('refuses a monitor whose hostname cannot be resolved', async () => {
    const id = await createMonitor('http://nowhere.invalid/');

    const outcome = await runScheduledCheck(db, testExecutor, id);

    expect(outcome).toMatchObject({ status: 'failure' });
    expect((await storedChecks(id))[0]?.error_type).toBe('dns');
  });
});

describe('scheduled checks drive incidents', () => {
  /** A monitor pointed at a server that always fails. */
  async function failingMonitor(): Promise<string> {
    const server = await startServer((_request, response) => {
      response.writeHead(503).end('down');
    });

    return createMonitor(`http://monitor.test:${String(server.port)}/`);
  }

  async function openIncidents(monitorId: string): Promise<number> {
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM incidents
        WHERE monitor_id = $1 AND status = 'open'`,
      [monitorId],
    );

    return Number(result.rows[0]?.count);
  }

  it('opens an incident after three scheduled failures', async () => {
    const id = await failingMonitor();

    const first = await runScheduledCheck(db, testExecutor, id);
    const second = await runScheduledCheck(db, testExecutor, id);
    const third = await runScheduledCheck(db, testExecutor, id);

    expect(first).toMatchObject({ incident: 'none' });
    expect(second).toMatchObject({ incident: 'none' });
    expect(third).toMatchObject({ incident: 'opened' });
    expect(await openIncidents(id)).toBe(1);
  });

  it('resolves the incident when the monitor recovers', async () => {
    // One server, whose answer changes: the monitor's URL never moves, which
    // is what a real recovery looks like.
    let healthy = false;
    const server = await startServer((_request, response) => {
      response.writeHead(healthy ? 200 : 503).end();
    });
    const id = await createMonitor(
      `http://monitor.test:${String(server.port)}/`,
    );

    for (let n = 0; n < 3; n += 1)
      await runScheduledCheck(db, testExecutor, id);
    expect(await openIncidents(id)).toBe(1);

    healthy = true;
    const recovery = await runScheduledCheck(db, testExecutor, id);

    expect(recovery).toMatchObject({ status: 'success', incident: 'resolved' });
    expect(await openIncidents(id)).toBe(0);
  });
});

describe('the worker process', () => {
  /**
   * Run a real Worker until it finishes one job, then close it gracefully.
   *
   * `close()` waits for in-flight jobs, which is what makes a redeploy safe: a
   * check is never abandoned halfway through its transaction and left to be
   * redelivered.
   */
  async function runOneJob(): Promise<void> {
    // A second connection, because a Worker blocks on its own.
    const workerRedis = createRedisConnection(config);

    const worker = new Worker<CheckJobData>(
      CHECKS_QUEUE_NAME,
      (job) => runScheduledCheck(db, testExecutor, job.data.monitorId),
      { connection: workerRedis, concurrency: 1, prefix: TEST_QUEUE_PREFIX },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('completed', () => {
          resolve();
        });
        worker.once('failed', (_job, error) => {
          reject(error);
        });
      });
    } finally {
      await worker.close();
      await workerRedis.quit();
    }
  }

  it('checks an active monitor on its schedule, end to end', async () => {
    // The whole path in one test: creating an active monitor establishes a job
    // scheduler, the scheduler produces a job, a real Worker picks it up, and
    // the check lands in PostgreSQL. Nothing is enqueued by hand.
    const server = await startServer((_request, response) => {
      response.writeHead(200).end('ok');
    });
    const id = await createMonitor(
      `http://monitor.test:${String(server.port)}/`,
    );

    await runOneJob();

    const checks = await storedChecks(id);
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(checks[0]?.status).toBe('success');
    expect(server.received.length).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('carries nothing but a monitor id in the job payload', async () => {
    // The rule that keeps user-supplied headers out of Redis. Asserted against
    // the job as BullMQ actually stores it, not against the type.
    const id = await createMonitor('http://monitor.test/', {
      headers: { 'X-Secretish': 'value' },
    });

    await queue.add(CHECK_JOB_NAME, { monitorId: id });
    const [job] = await queue.getJobs(['waiting', 'delayed', 'prioritized']);

    expect(job?.data).toEqual({ monitorId: id });
    expect(JSON.stringify(job?.data)).not.toContain('value');
  });

  it('leaves a paused monitor unchecked even if a job reaches the worker', async () => {
    // Pausing removes the schedule, but a job already queued at that moment
    // still arrives. The worker reloads the row and declines — the second line
    // of defence that makes pause actually mean stop.
    const server = await startServer((_request, response) => {
      response.writeHead(200).end('ok');
    });
    const id = await createMonitor(
      `http://monitor.test:${String(server.port)}/`,
      { active: false },
    );

    await queue.add(CHECK_JOB_NAME, { monitorId: id });
    await runOneJob();

    expect(server.received).toHaveLength(0);
    expect(await storedChecks(id)).toHaveLength(0);
  }, 20_000);
});
