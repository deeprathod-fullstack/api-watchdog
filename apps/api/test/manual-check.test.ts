import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';

import {
  createCheckClient,
  type SafeResolve,
  type UrlGuard,
} from '../src/checks/http-client.js';
import type { ResolvedAddress } from '../src/checks/safe-lookup.js';
import type { CheckExecutor } from '../src/checks/service.js';
import { guardUrl } from '../src/checks/url-guard.js';
import { createManualCheckRateLimiter } from '../src/middleware/rate-limit.js';
import {
  buildTestApp,
  deleteTestUsers,
  registerTestUser,
  testConfig,
  testPool,
  type TestUser,
} from './helpers.js';

/**
 * Integration tests for POST /api/monitors/:id/check against real PostgreSQL
 * and real sockets.
 *
 * No policy bypass and no environment variable: the executor is injected, the
 * static guard is the real `guardUrl` for everything except an ephemeral test
 * port, and the address rules are never relaxed. Monitors point at
 * `monitor.test`, a reserved TLD that cannot resolve, so reaching the local
 * server is only possible through the validated pinned address.
 */

const config = testConfig();
const db = testPool(config);

const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };

let owner: TestUser;
let other: TestUser;

interface TestServer {
  port: number;
  received: IncomingHttpHeaders[];
  paths: string[];
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
  const paths: string[] = [];

  const server = http.createServer((request_, response) => {
    received.push(request_.headers);
    paths.push(request_.url ?? '');
    handler(request_, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as AddressInfo).port;
  testPorts.add(port);

  const testServer: TestServer = {
    port,
    received,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  servers.push(testServer);
  return testServer;
}

/** The real static policy, conceding only an ephemeral test port. */
const testGuard: UrlGuard = (url) => {
  const parsed = new URL(url);
  const port = Number(parsed.port);

  if (!testPorts.has(port)) return guardUrl(url);

  const probe = new URL(url);
  probe.port = '';
  const real = guardUrl(probe.href);
  if (!real.ok) return real;

  return { ok: true, target: { ...real.target, port, url: parsed.href } };
};

/** Resolver stub: hostnames the tests control, with the real verdict shapes. */
const resolve: SafeResolve = (hostname) => {
  if (hostname === 'monitor.test' || hostname === 'other.test') {
    return Promise.resolve({ ok: true, addresses: [LOOPBACK] });
  }

  if (hostname === 'internal.test') {
    return Promise.resolve({
      ok: false,
      reason: 'blocked_address',
      detail: 'private',
      address: '10.0.0.5',
    });
  }

  // Everything else, including `nowhere.test`, fails to resolve.
  return Promise.resolve({ ok: false, reason: 'dns' });
};

const executor: CheckExecutor = {
  guard: testGuard,
  resolve,
  client: createCheckClient({ resolve, guard: testGuard }),
};

const app: Express = buildTestApp(config, db, { checkExecutor: executor });

const checkSchema = z.strictObject({
  id: z.string(),
  monitorId: z.uuid(),
  status: z.enum(['success', 'failure']),
  httpStatus: z.number().int().nullable(),
  responseTimeMs: z.number().int().nonnegative(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

beforeAll(async () => {
  owner = await registerTestUser(app);
  other = await registerTestUser(app);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));

  // Each test creates its own monitors; without this the per-user cap of 20
  // is reached partway through the file. Check results cascade with the
  // monitor rows.
  await db.query('DELETE FROM monitors WHERE user_id = ANY($1)', [
    [owner.id, other.id],
  ]);
});

afterAll(async () => {
  await deleteTestUsers(db, [owner, other]);
  await db.end();
});

/** Create a monitor owned by `user`. Check results cascade with it. */
async function createMonitor(
  user: TestUser,
  overrides: Record<string, unknown>,
): Promise<string> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      name: 'Check target',
      url: 'http://monitor.test/',
      intervalSeconds: 300,
      timeoutMs: 5000,
      ...overrides,
    });

  expect(response.status).toBe(201);

  return (response.body as { monitor: { id: string } }).monitor.id;
}

async function runCheck(
  user: TestUser,
  monitorId: string,
  targetApp: Express = app,
) {
  return request(targetApp)
    .post(`/api/monitors/${monitorId}/check`)
    .set('Authorization', `Bearer ${user.token}`);
}

async function storedRows(monitorId: string) {
  const result = await db.query<{
    status: string;
    http_status: number | null;
    response_time_ms: number;
    error_type: string | null;
    error_message: string | null;
  }>(
    `SELECT status, http_status, response_time_ms, error_type, error_message
       FROM check_results WHERE monitor_id = $1 ORDER BY id`,
    [monitorId],
  );

  return result.rows;
}

/** Run a check and assert it produced exactly one row; return that row. */
async function checkOnce(user: TestUser, monitorId: string) {
  const response = await runCheck(user, monitorId);

  expect(response.status).toBe(200);
  const parsed = z
    .strictObject({ check: checkSchema })
    .parse(response.body).check;

  const rows = await storedRows(monitorId);
  // Every attempted check persists exactly one row — no duplicates, no gaps.
  expect(rows).toHaveLength(1);

  return { body: parsed, row: rows[0] };
}

describe('authentication and ownership', () => {
  it('requires a token', async () => {
    const monitorId = await createMonitor(owner, {});

    const response = await request(app).post(
      `/api/monitors/${monitorId}/check`,
    );

    expect(response.status).toBe(401);
    expect(errorSchema.parse(response.body).error.code).toBe('unauthenticated');
    expect(await storedRows(monitorId)).toHaveLength(0);
  });

  it('answers 404 for another user monitor and writes nothing', async () => {
    const monitorId = await createMonitor(owner, {});

    const response = await runCheck(other, monitorId);

    expect(response.status).toBe(404);
    expect(errorSchema.parse(response.body).error.code).toBe('not_found');
    expect(await storedRows(monitorId)).toHaveLength(0);
  });

  it('answers 404 for a malformed or unknown id', async () => {
    for (const id of ['not-a-uuid', '11111111-1111-4111-8111-111111111111']) {
      const response = await request(app)
        .post(`/api/monitors/${id}/check`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(response.status).toBe(404);
    }
  });

  it('checks a paused monitor', async () => {
    // Pause governs the future scheduler; checking by hand is why the button
    // exists.
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
      active: false,
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.status).toBe('success');
    expect(row?.status).toBe('success');
  });
});

describe('successful checks', () => {
  it('records a success when the status matches', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/health`,
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.status).toBe('success');
    expect(body.httpStatus).toBe(200);
    expect(body.errorType).toBeNull();
    expect(body.errorMessage).toBeNull();
    expect(row?.error_type).toBeNull();
    expect(row?.error_message).toBeNull();
    expect(server.paths).toEqual(['/health']);
  });

  it('honours a non-default expected status', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
      expectedStatus: 204,
    });

    const { body } = await checkOnce(owner, monitorId);

    expect(body.status).toBe('success');
    expect(body.httpStatus).toBe(204);
  });
});

describe('status mismatch', () => {
  it('persists the actual status with a status_mismatch classifier', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
    });

    const { body, row } = await checkOnce(owner, monitorId);

    // The endpoint itself succeeded: the check ran and was stored.
    expect(body.status).toBe('failure');
    expect(body.httpStatus).toBe(503);
    expect(body.errorType).toBe('status_mismatch');
    expect(row?.http_status).toBe(503);
    expect(row?.error_message).toBe('Expected status 200, received 503');
  });
});

describe('SSRF and network failures', () => {
  it('blocks a statically impossible URL before any network activity', async () => {
    // Port 8080 is not an allowed port, so the real guard rejects it.
    const monitorId = await createMonitor(owner, {
      url: 'http://monitor.test:8080/',
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.status).toBe('failure');
    expect(body.errorType).toBe('blocked_url');
    expect(body.httpStatus).toBeNull();
    // Nothing was attempted over the network.
    expect(body.responseTimeMs).toBe(0);
    expect(row?.error_message).toBe('Target rejected: port_not_allowed');
  });

  it('blocks an initial URL pointing at the instance metadata service', async () => {
    const monitorId = await createMonitor(owner, {
      url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('blocked_address');
    expect(body.httpStatus).toBeNull();
    expect(body.responseTimeMs).toBe(0);
    expect(row?.error_message).toContain('link_local');
  });

  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://[::ffff:169.254.169.254]/',
  ])('blocks the initial address in %s', async (url) => {
    const monitorId = await createMonitor(owner, { url });

    const { body } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('blocked_address');
  });

  it('blocks a hostname that resolves to a private address', async () => {
    const monitorId = await createMonitor(owner, {
      url: 'http://internal.test/',
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('blocked_address');
    expect(body.httpStatus).toBeNull();
    expect(row?.error_message).toBe(
      'Resolved address 10.0.0.5 is not allowed (private)',
    );
  });

  it('blocks a redirect to an internal address', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, {
        Location: 'http://169.254.169.254/latest/meta-data/',
      });
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('blocked_address');
    expect(row?.error_message).toBe(
      'Redirect blocked: address_not_allowed: link_local',
    );
  });

  it('blocks a redirect to a hostname that resolves internally', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { Location: 'http://internal.test/' });
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
    });

    const { body } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('blocked_address');
  });

  it('records a DNS failure', async () => {
    const monitorId = await createMonitor(owner, {
      url: 'http://nowhere.test/',
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('dns');
    expect(body.httpStatus).toBeNull();
    expect(row?.error_message).toBe('Hostname could not be resolved');
  });

  it('records a refused connection', async () => {
    const server = await startServer((_request, response) => {
      response.end();
    });
    const port = server.port;
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(port)}/`,
    });
    await server.close();
    servers.splice(0);

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('connection_refused');
    expect(row?.error_message).toBe('Connection refused');
  });

  it('records a timeout', async () => {
    const server = await startServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200);
          response.end();
        }
      }, 4000);
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
      // The smallest timeout the schema allows, with an interval to match.
      timeoutMs: 1000,
      intervalSeconds: 1,
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('timeout');
    expect(body.httpStatus).toBeNull();
    expect(row?.error_message).toBe('Timed out after 1000 ms');
  });

  it('records too many redirects', async () => {
    const server = await startServer((request_, response) => {
      const hop = Number(request_.url?.slice(1)) || 0;
      response.writeHead(302, { Location: `/${String(hop + 1)}` });
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/0`,
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('too_many_redirects');
    expect(row?.error_message).toBe('Exceeded 3 redirects');
    expect(server.paths).toEqual(['/0', '/1', '/2', '/3']);
  });

  it('records an invalid response', async () => {
    const server = await startServer((_request, response) => {
      const headers: Record<string, string> = {};
      for (let index = 0; index < 150; index += 1) {
        headers[`X-Filler-${String(index)}`] = 'v';
      }
      response.writeHead(200, headers);
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
    });

    const { body } = await checkOnce(owner, monitorId);

    expect(body.errorType).toBe('invalid_response');
    expect(body.httpStatus).toBeNull();
  });
});

describe('what is never persisted or logged', () => {
  it('stores nothing from the response body', async () => {
    const marker = 'BODY-MARKER-8fd3ac';
    const server = await startServer((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(`${marker} `.repeat(1000));
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
    });

    const { body, row } = await checkOnce(owner, monitorId);

    expect(JSON.stringify(body)).not.toContain(marker);
    expect(JSON.stringify(row)).not.toContain(marker);
    // The whole row, every column, from the database itself.
    const full = await db.query(
      'SELECT * FROM check_results WHERE monitor_id = $1',
      [monitorId],
    );
    expect(JSON.stringify(full.rows)).not.toContain(marker);
  });

  it('sends the configured header but stores and logs nothing of it', async () => {
    const secretish = 'HEADER-VALUE-3c91fe';
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
      (method) =>
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(' '));
        }),
    );

    try {
      const server = await startServer((_request, response) => {
        response.writeHead(500);
        response.end();
      });
      const monitorId = await createMonitor(owner, {
        url: `http://monitor.test:${String(server.port)}/`,
        headers: { 'X-Trace-Id': secretish },
      });

      const { body, row } = await checkOnce(owner, monitorId);

      // The header really was sent — otherwise this test would pass simply
      // because the feature is broken.
      expect(server.received[0]?.['x-trace-id']).toBe(secretish);

      expect(JSON.stringify(body)).not.toContain(secretish);
      expect(JSON.stringify(row)).not.toContain(secretish);
      expect(logs.join('\n')).not.toContain(secretish);

      // And the log line that was written carries only allowlisted fields.
      const checkLog = logs.find((line) => line.includes('manual_check'));
      expect(checkLog).toBeDefined();
      expect(
        Object.keys(JSON.parse(checkLog ?? '{}') as object).sort(),
      ).toEqual([
        'elapsedMs',
        'errorType',
        'event',
        'hostname',
        'monitorId',
        'outcome',
        'userId',
      ]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('rate limiting', () => {
  it('allows ten manual checks per user and then refuses', async () => {
    // A separate app with the real limiter; the shared app bypasses it.
    const limitedApp = buildTestApp(config, db, {
      checkExecutor: executor,
      manualCheckRateLimiter: createManualCheckRateLimiter(),
    });

    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await runCheck(owner, monitorId, limitedApp);
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, () => 200),
    );
    expect(statuses[10]).toBe(429);

    // The refused request performed no check and stored no row.
    expect(await storedRows(monitorId)).toHaveLength(10);

    // A different user has their own bucket.
    const otherMonitor = await createMonitor(other, {
      url: `http://monitor.test:${String(server.port)}/`,
    });
    const otherResponse = await runCheck(other, otherMonitor, limitedApp);
    expect(otherResponse.status).toBe(200);
  });
});

describe('one row per attempt', () => {
  it('appends exactly one row for each repeated check', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await runCheck(owner, monitorId);
      expect(response.status).toBe(200);
      expect(await storedRows(monitorId)).toHaveLength(attempt);
    }
  });

  it('returns an id that is a string, not a lossy number', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const monitorId = await createMonitor(owner, {
      url: `http://monitor.test:${String(server.port)}/`,
    });

    const { body } = await checkOnce(owner, monitorId);

    // bigint identity: a JS number would silently lose precision past 2^53.
    expect(typeof body.id).toBe('string');
  });
});
