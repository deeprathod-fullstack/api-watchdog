import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildTestApp,
  deleteTestUsers,
  registerTestUser,
  testConfig,
  testPool,
  type TestUser,
} from './helpers.js';

/**
 * The static URL policy at the CRUD boundary.
 *
 * These tests pin one property: a URL the check pipeline would reject on
 * *every* run is refused when the monitor is created or edited, rather than
 * accepted and left to record permanent failures forever.
 *
 * They are deliberately not a second copy of the SSRF suite — `guardUrl` is
 * exhaustively tested in `checks-url-guard.test.ts`. What is verified here is
 * that the HTTP boundary actually calls it, on both POST and PATCH, and answers
 * 400. The one property re-tested on purpose is that CRUD performs no DNS and
 * no outbound request; see the hostname cases below.
 */

const config = testConfig();
const db = testPool(config);
// No check executor is supplied, so the helper's stub throws if anything in
// this file causes an outbound attempt. That is itself one of the assertions.
const app: Express = buildTestApp(config, db);

let owner: TestUser;

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const validMonitor = {
  name: 'Example API',
  url: 'https://example.com/status',
  intervalSeconds: 300,
  timeoutMs: 5000,
};

beforeAll(async () => {
  owner = await registerTestUser(app);
});

// The per-user monitor cap is well below the number of cases here, so each
// test starts from an empty account rather than racing the limit.
beforeEach(async () => {
  await db.query('DELETE FROM monitors WHERE user_id = $1', [owner.id]);
});

afterAll(async () => {
  await deleteTestUsers(db, [owner]);
  await db.end();
});

/** POST a monitor with this URL and return the response status. */
async function postUrl(url: string): Promise<number> {
  const response = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ ...validMonitor, url });

  return response.status;
}

/**
 * URLs the check pipeline could never fetch, whatever the day's DNS says.
 *
 * Each is decidable without a packet: the scheme, the credentials, the port and
 * the literal address are all written into the URL itself.
 */
const staticallyRejected: [label: string, url: string][] = [
  ['a non-HTTP scheme', 'file:///etc/passwd'],
  ['a gopher URL', 'gopher://example.com/'],
  ['credentials in the authority', 'https://user:pw@example.com/'],
  ['a username with no password', 'https://user@example.com/'],
  ['a non-default http port', 'http://example.com:8080/'],
  ['a non-default https port', 'https://example.com:8443/'],
  ['https on port 80', 'https://example.com:80/'],
  ['http on port 443', 'http://example.com:443/'],
  ['the SSH port', 'http://example.com:22/'],
  ['loopback as a literal', 'http://127.0.0.1/'],
  ['loopback in short notation', 'http://127.1/'],
  ['IPv6 loopback', 'http://[::1]/'],
  ['a private RFC1918 address', 'http://10.0.0.5/'],
  ['the cloud metadata address', 'http://169.254.169.254/'],
  ['the IPv4-mapped IPv6 form of loopback', 'http://[::ffff:127.0.0.1]/'],
];

describe('POST /api/monitors URL policy', () => {
  it.each(staticallyRejected)('rejects %s', async (_label, url) => {
    expect(await postUrl(url)).toBe(400);
  });

  it('answers with the validation error envelope, not a 500', async () => {
    const response = await request(app)
      .post('/api/monitors')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ ...validMonitor, url: 'http://127.0.0.1/' });

    expect(response.status).toBe(400);
    expect(errorSchema.parse(response.body).error.code).toBe(
      'validation_failed',
    );
  });

  it('never echoes the submitted URL back in the error message', async () => {
    // An error message gets logged, displayed and forwarded to error tracking.
    // Reflecting input into it is how a credential written into a URL ends up
    // somewhere it was never meant to be.
    const response = await request(app)
      .post('/api/monitors')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ ...validMonitor, url: 'https://user:hunter2@example.com/' });

    expect(response.status).toBe(400);
    const { message } = errorSchema.parse(response.body).error;
    expect(message).not.toContain('hunter2');
    expect(message).toContain('url');
  });

  /**
   * The other half of the policy: hostnames stay allowed.
   *
   * CRUD does no DNS, so a name is judged on its shape alone. Every one of
   * these would be blocked at check time by the resolver — which is where that
   * decision belongs, because the answer can change after we store the row.
   */
  const hostnamesAllowed = [
    'https://example.com/status',
    'http://example.com/status',
    'https://localhost/status',
    'https://localhost./status',
    'https://127.0.0.1.nip.io/status',
    'https://metadata.google.internal/status',
  ];

  it.each(hostnamesAllowed)(
    'accepts the hostname-based URL %s without resolving it',
    async (url) => {
      expect(await postUrl(url)).toBe(201);
    },
  );

  it('preserves path and query casing on an accepted URL', async () => {
    const response = await request(app)
      .post('/api/monitors')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ ...validMonitor, url: 'HTTPS://example.com/Status?Check=1' });

    expect(response.status).toBe(201);
    const body = response.body as { monitor: { url: string } };
    // The scheme is normalised; the rest is left exactly as sent. The guard
    // validates a URL, it does not rewrite one.
    expect(body.monitor.url).toBe('https://example.com/Status?Check=1');
  });
});

describe('PATCH /api/monitors/:id URL policy', () => {
  /** A monitor owned by `owner`, with a valid URL. */
  async function createMonitor(): Promise<string> {
    const response = await request(app)
      .post('/api/monitors')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ ...validMonitor, name: 'Patch subject' });

    expect(response.status).toBe(201);

    return (response.body as { monitor: { id: string } }).monitor.id;
  }

  it.each(staticallyRejected)(
    'rejects a patch to %s and leaves the stored URL untouched',
    async (_label, url) => {
      const id = await createMonitor();

      const patch = await request(app)
        .patch(`/api/monitors/${id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ url });

      expect(patch.status).toBe(400);

      // The half that matters: a rejected patch must not have written anything.
      const after = await request(app)
        .get(`/api/monitors/${id}`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect((after.body as { monitor: { url: string } }).monitor.url).toBe(
        validMonitor.url,
      );
    },
  );

  it('accepts a patch to another valid URL', async () => {
    const id = await createMonitor();

    const patch = await request(app)
      .patch(`/api/monitors/${id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ url: 'https://another.example/health' });

    expect(patch.status).toBe(200);
    expect((patch.body as { monitor: { url: string } }).monitor.url).toBe(
      'https://another.example/health',
    );
  });

  it('leaves the URL alone when the patch does not mention it', async () => {
    const id = await createMonitor();

    const patch = await request(app)
      .patch(`/api/monitors/${id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Renamed only' });

    expect(patch.status).toBe(200);
    const body = patch.body as { monitor: { url: string; name: string } };
    expect(body.monitor.name).toBe('Renamed only');
    expect(body.monitor.url).toBe(validMonitor.url);
  });
});
