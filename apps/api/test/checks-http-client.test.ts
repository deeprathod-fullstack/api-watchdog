import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CheckOutcome,
  type CheckTarget,
  createCheckClient,
  type SafeResolve,
  type UrlGuard,
} from '../src/checks/http-client.js';
import type { ResolvedAddress } from '../src/checks/safe-lookup.js';
import { guardUrl } from '../src/checks/url-guard.js';

/**
 * These tests drive real sockets against real local servers.
 *
 * They need no policy bypass and no environment variable. The client's contract
 * is "receive a hostname plus already-validated addresses", so a test simply
 * hands it `monitor.test` pinned to `127.0.0.1`. `ip-rules` stays untouched and
 * strict throughout.
 *
 * `.test` is a reserved TLD that can never resolve, which makes the pinning
 * proof airtight: if the client performed its own DNS lookup, every one of
 * these requests would fail.
 */

const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };

interface TestServer {
  port: number;
  /** Headers of every request the server received, in order. */
  received: IncomingHttpHeaders[];
  paths: string[];
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

async function startServer(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
): Promise<TestServer> {
  const received: IncomingHttpHeaders[] = [];
  const paths: string[] = [];

  const server = http.createServer((request, response) => {
    received.push(request.headers);
    paths.push(request.url ?? '');
    handler(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const testServer: TestServer = {
    port: (server.address() as AddressInfo).port,
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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Ephemeral ports the test guard tolerates; see `testGuard`. */
const testPorts = new Set<number>();

/**
 * The real static policy, with one concession: an ephemeral test port.
 *
 * The production policy allows ports 80 and 443 only, which would make a
 * redirect to a local test server unreachable. Every other rule — scheme
 * allowlist, credentials, IP literal classification — runs unmodified, and a
 * separate test asserts the *default* guard rejects a non-standard port.
 */
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

/** A resolver stub mapping hostnames to validated addresses. */
function resolverFor(
  map: Record<string, ResolvedAddress[] | 'dns' | ResolvedAddress>,
): SafeResolve {
  return vi.fn((hostname: string) => {
    const entry = map[hostname];

    if (entry === undefined || entry === 'dns') {
      return Promise.resolve({ ok: false as const, reason: 'dns' as const });
    }

    if (!Array.isArray(entry)) {
      return Promise.resolve({
        ok: false as const,
        reason: 'blocked_address' as const,
        detail: 'private' as const,
        address: entry.address,
      });
    }

    return Promise.resolve({ ok: true as const, addresses: entry });
  });
}

function target(
  hostname: string,
  port: number,
  path = '/',
  scheme = 'http',
): CheckTarget {
  testPorts.add(port);

  return {
    url: `${scheme}://${hostname}:${String(port)}${path}`,
    hostname,
    port,
    addresses: [LOOPBACK],
  };
}

function client(
  resolve: SafeResolve = resolverFor({}),
  guard: UrlGuard = testGuard,
) {
  return createCheckClient({ resolve, guard });
}

const ok = (outcome: CheckOutcome) => {
  if (!outcome.ok)
    throw new Error(`expected success, got ${outcome.failure.kind}`);
  return outcome;
};

const failed = (outcome: CheckOutcome) => {
  if (outcome.ok)
    throw new Error(`expected failure, got ${outcome.httpStatus}`);
  return outcome;
};

// ── A. Real socket integration ──────────────────────────────────────────────

describe('A. real socket integration', () => {
  it('connects to the pinned address and never resolves DNS itself', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const resolve = resolverFor({});

    const outcome = await client(resolve)({
      // `monitor.test` cannot resolve; reaching the server proves the pinned
      // address was used.
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(ok(outcome).httpStatus).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('sends the original hostname in the Host header, not the pinned IP', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    await client()({
      target: target('monitor.test', server.port, '/health'),
      timeoutMs: 2000,
      headers: {},
    });

    expect(server.received[0]?.host).toBe(
      `monitor.test:${String(server.port)}`,
    );
    expect(server.paths[0]).toBe('/health');
  });

  it('passes the path and query through unchanged', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await client()({
      target: target('monitor.test', server.port, '/Status/Path?Check=TRUE'),
      timeoutMs: 2000,
      headers: {},
    });

    expect(server.paths[0]).toBe('/Status/Path?Check=TRUE');
  });

  it('reports a connection refused against a closed port', async () => {
    const server = await startServer((_request, response) => {
      response.end();
    });
    const port = server.port;
    await server.close();
    servers.splice(0);

    const outcome = await client()({
      target: {
        ...target('monitor.test', port),
        url: `http://monitor.test:${String(port)}/`,
      },
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({ kind: 'connection_refused' });
  });
});

// ── B. Timeout budget ───────────────────────────────────────────────────────

describe('B. one timeout budget', () => {
  it('times out when the response headers are delayed past the budget', async () => {
    const server = await startServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200);
        response.end();
      }, 1500);
    });

    const started = Date.now();
    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 200,
      headers: {},
    });
    const wall = Date.now() - started;

    expect(failed(outcome).failure).toEqual({ kind: 'timeout' });
    expect(wall).toBeLessThan(1000);
  });

  it('spends ONE budget across redirect hops rather than one per hop', async () => {
    // Three hops, each delayed 120ms, against a 250ms total budget. A per-hop
    // timeout would let all three through; a single deadline must not.
    const server = await startServer((request, response) => {
      const hop =
        Number(new URL(request.url ?? '/', 'http://x').pathname.slice(1)) || 0;

      setTimeout(() => {
        if (hop >= 3) {
          response.writeHead(200);
          response.end();
          return;
        }
        response.writeHead(302, { Location: `/${String(hop + 1)}` });
        response.end();
      }, 120);
    });

    const resolve = resolverFor({ 'monitor.test': [LOOPBACK] });

    const outcome = await client(resolve)({
      target: target('monitor.test', server.port, '/0'),
      timeoutMs: 250,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({ kind: 'timeout' });
    expect(failed(outcome).responseTimeMs).toBeLessThan(600);
  });

  it('times out on a slow DNS lookup for a redirect target', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { Location: '/next' });
      response.end();
    });

    const slowResolve: SafeResolve = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, addresses: [LOOPBACK] }), 2000);
      });

    const outcome = await client(slowResolve)({
      target: target('monitor.test', server.port),
      timeoutMs: 200,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({ kind: 'timeout' });
  });

  it('returns timeout without a request when the budget is already spent', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 0,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({ kind: 'timeout' });
    expect(server.received).toHaveLength(0);
  });
});

// ── C. Redirects ────────────────────────────────────────────────────────────

describe('C. redirects', () => {
  it('follows a same-origin redirect with a relative Location', async () => {
    const server = await startServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { Location: '/next' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end();
    });

    const resolve = resolverFor({ 'monitor.test': [LOOPBACK] });
    const outcome = await client(resolve)({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(ok(outcome).httpStatus).toBe(200);
    expect(ok(outcome).redirectCount).toBe(1);
    expect(server.paths).toEqual(['/', '/next']);
    // Every hop is revalidated, even a same-origin one.
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('follows a cross-origin redirect and pins the new host separately', async () => {
    const second = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const first = await startServer((_request, response) => {
      response.writeHead(301, {
        Location: `http://other.test:${String(second.port)}/moved`,
      });
      response.end();
    });
    testPorts.add(second.port);

    const resolve = resolverFor({ 'other.test': [LOOPBACK] });
    const outcome = await client(resolve)({
      target: target('monitor.test', first.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(ok(outcome).httpStatus).toBe(200);
    expect(ok(outcome).finalUrl).toContain('other.test');
    // The second hop got its own resolution and its own pinned set.
    expect(resolve).toHaveBeenCalledWith('other.test');
    expect(second.received[0]?.host).toBe(`other.test:${String(second.port)}`);
    expect(second.paths).toEqual(['/moved']);
  });

  it('follows exactly three redirects and refuses the fourth', async () => {
    const server = await startServer((request, response) => {
      const hop = Number(request.url?.slice(1)) || 0;
      response.writeHead(302, { Location: `/${String(hop + 1)}` });
      response.end();
    });

    const resolve = resolverFor({ 'monitor.test': [LOOPBACK] });
    const outcome = await client(resolve)({
      target: target('monitor.test', server.port, '/0'),
      timeoutMs: 4000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'too_many_redirects',
      detail: 'limit',
    });
    // Four requests made: the original plus three followed redirects.
    expect(server.paths).toEqual(['/0', '/1', '/2', '/3']);
  });

  it('detects a redirect loop before exhausting the hop budget', async () => {
    const server = await startServer((request, response) => {
      response.writeHead(302, {
        Location: request.url === '/a' ? '/b' : '/a',
      });
      response.end();
    });

    const resolve = resolverFor({ 'monitor.test': [LOOPBACK] });
    const outcome = await client(resolve)({
      target: target('monitor.test', server.port, '/a'),
      timeoutMs: 4000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'too_many_redirects',
      detail: 'loop',
    });
    expect(server.paths).toEqual(['/a', '/b']);
  });

  it('blocks a redirect to a private IP literal', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { Location: 'http://10.0.0.5/internal' });
      response.end();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'blocked_redirect',
      reason: 'address_not_allowed',
      detail: 'private',
    });
  });

  it('blocks a redirect to the instance metadata service', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, {
        Location: 'http://169.254.169.254/latest/meta-data/',
      });
      response.end();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'blocked_redirect',
      reason: 'address_not_allowed',
      detail: 'link_local',
    });
  });

  it('blocks a redirect to a hostname that resolves to a private address', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { Location: 'http://evil.test/internal' });
      response.end();
    });

    const resolve = resolverFor({
      'evil.test': { address: '10.0.0.5', family: 4 },
    });

    const outcome = await client(resolve)({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'blocked_redirect',
      reason: 'blocked_address',
      detail: 'private',
    });
  });

  it('blocks a redirect whose host has one disallowed answer among several', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { Location: 'http://mixed.test/' });
      response.end();
    });

    // The resolver applies the all-or-nothing rule from Phase B; the client
    // must honour its verdict rather than picking the usable address.
    const resolve = resolverFor({
      'mixed.test': { address: '169.254.169.254', family: 4 },
    });

    const outcome = await client(resolve)({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure.kind).toBe('blocked_redirect');
  });

  it('blocks a redirect to a non-HTTP scheme', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { Location: 'file:///etc/passwd' });
      response.end();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'blocked_redirect',
      reason: 'scheme_not_allowed',
    });
  });

  it('reports a redirect target that cannot be resolved as a dns failure', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(307, { Location: 'http://nowhere.test/' });
      response.end();
    });

    const outcome = await client(resolverFor({ 'nowhere.test': 'dns' }))({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({ kind: 'dns' });
  });

  it.each([301, 302, 303, 307, 308])('follows %i', async (status) => {
    const server = await startServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(status, { Location: '/next' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end();
    });

    const outcome = await client(resolverFor({ 'monitor.test': [LOOPBACK] }))({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(ok(outcome).httpStatus).toBe(200);
    expect(ok(outcome).redirectCount).toBe(1);
  });

  it('does NOT follow a 304 that carries a Location header', async () => {
    // Regression test: only 301/302/303/307/308 are redirects. A 304 is a
    // final response, and a user may legitimately expect one.
    const server = await startServer((_request, response) => {
      response.writeHead(304, { Location: 'http://169.254.169.254/' });
      response.end();
    });

    const resolve = resolverFor({});
    const outcome = await client(resolve)({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(ok(outcome).httpStatus).toBe(304);
    expect(ok(outcome).redirectCount).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(server.paths).toEqual(['/']);
  });

  it.each([300, 305, 306, 310])(
    'treats %i with a Location as a final response',
    async (status) => {
      const server = await startServer((_request, response) => {
        response.writeHead(status, { Location: '/next' });
        response.end();
      });

      const outcome = await client()({
        target: target('monitor.test', server.port),
        timeoutMs: 2000,
        headers: {},
      });

      expect(ok(outcome).httpStatus).toBe(status);
      expect(server.paths).toEqual(['/']);
    },
  );

  it('treats a redirect status with no Location as a final response', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(301);
      response.end();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(ok(outcome).httpStatus).toBe(301);
  });

  it('rejects a redirect to a non-standard port under the DEFAULT guard', async () => {
    // Proof that the production policy is intact: with no guard injected, the
    // real 80/443-only rule applies and the test port is refused.
    const server = await startServer((_request, response) => {
      response.writeHead(302, { Location: 'http://other.test:8080/next' });
      response.end();
    });

    const strict = createCheckClient({
      resolve: resolverFor({ 'other.test': [LOOPBACK] }),
    });

    const outcome = await strict({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'blocked_redirect',
      reason: 'port_not_allowed',
    });
  });
});

// ── D. TLS ──────────────────────────────────────────────────────────────────

describe('D. TLS', () => {
  it('fails the handshake rather than downgrading when the peer is not TLS', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port, '/', 'https'),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure.kind).toBe('tls');
  });

  it('introduces no certificate-verification bypass', () => {
    const source = readFileSync(
      new URL('../src/checks/http-client.ts', import.meta.url),
      'utf8',
    );

    for (const bypass of [
      'rejectUnauthorized',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'checkServerIdentity',
      'secureOptions',
      'insecure',
    ]) {
      expect(source).not.toContain(bypass);
    }
  });
});

// ── E. Body and resource safety ─────────────────────────────────────────────

describe('E. body and resource safety', () => {
  it('does not consume a large streaming body and closes the socket', async () => {
    let chunksWritten = 0;
    let closed = false;

    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.on('close', () => {
        closed = true;
      });

      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const pump = (): void => {
        if (response.destroyed || response.writableEnded) return;
        if (chunksWritten >= 800) {
          response.end();
          return;
        }
        chunksWritten += 1;
        response.write(chunk, () => setImmediate(pump));
      };
      pump();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 3000,
      headers: {},
    });

    expect(ok(outcome).httpStatus).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 100));

    // The client took the headers and left: the server never got to stream the
    // full 50 MB, and its response was closed underneath it.
    expect(chunksWritten).toBeLessThan(800);
    expect(closed).toBe(true);
  });

  it('asks for an identity encoding', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(server.received[0]?.['accept-encoding']).toBe('identity');
  });

  it('rejects a response with too many headers', async () => {
    const server = await startServer((_request, response) => {
      const headers: Record<string, string> = {};
      for (let index = 0; index < 150; index += 1) {
        headers[`X-Filler-${String(index)}`] = 'v';
      }
      response.writeHead(200, headers);
      response.end();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'invalid_response',
      detail: 'header_limit',
    });
  });

  it('rejects a response whose headers exceed the byte limit', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'X-Huge': 'a'.repeat(32 * 1024) });
      response.end();
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: {},
    });

    expect(failed(outcome).failure).toEqual({
      kind: 'invalid_response',
      detail: 'header_limit',
    });
  });
});

// ── F. Response-time measurement ────────────────────────────────────────────

describe('F. response time measurement', () => {
  it('measures to the first byte of the response, not the end of the body', async () => {
    const server = await startServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200);
        // `flushHeaders` matters: without it Node holds the headers until the
        // body is written, and the first byte genuinely would not arrive until
        // the end. Flushing lets this test assert what it claims to — that the
        // measurement stops at the first byte and does not wait for the body.
        response.flushHeaders();
        setTimeout(() => {
          if (!response.destroyed) response.end('x');
        }, 1500);
      }, 150);
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 3000,
      headers: {},
    });

    const { responseTimeMs } = ok(outcome);
    expect(responseTimeMs).toBeGreaterThanOrEqual(140);
    expect(responseTimeMs).toBeLessThan(1000);
    expect(Number.isInteger(responseTimeMs)).toBe(true);
  });

  it('accumulates time across redirect hops', async () => {
    const server = await startServer((request, response) => {
      setTimeout(() => {
        if (request.url === '/') {
          response.writeHead(302, { Location: '/next' });
          response.end();
          return;
        }
        response.writeHead(200);
        response.end();
      }, 120);
    });

    const outcome = await client(resolverFor({ 'monitor.test': [LOOPBACK] }))({
      target: target('monitor.test', server.port),
      timeoutMs: 3000,
      headers: {},
    });

    // Two hops of ~120ms each: the clock kept running across the redirect.
    expect(ok(outcome).responseTimeMs).toBeGreaterThanOrEqual(230);
  });

  it('reports a non-negative integer on failure too', async () => {
    const server = await startServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200);
        response.end();
      }, 1000);
    });

    const outcome = await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 150,
      headers: {},
    });

    const { responseTimeMs } = failed(outcome);
    expect(Number.isInteger(responseTimeMs)).toBe(true);
    expect(responseTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// ── G. Header safety and ownership ──────────────────────────────────────────

describe('G. header ownership and safety', () => {
  it('sends the configured monitor headers on the initial request', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: { 'X-Trace-Id': 'abc-123', Accept: 'application/json' },
    });

    expect(server.received[0]?.['x-trace-id']).toBe('abc-123');
    expect(server.received[0]?.accept).toBe('application/json');
  });

  it('does not let a configured Host override the target', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: { Host: 'evil.example', host: 'evil.example' },
    });

    // Host is owned by the client and always matches the validated target.
    expect(server.received[0]?.host).toBe(
      `monitor.test:${String(server.port)}`,
    );
    expect(JSON.stringify(server.received[0])).not.toContain('evil.example');
  });

  it('does not let a configured Accept-Encoding override identity', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: { 'Accept-Encoding': 'gzip, br', 'accept-encoding': 'deflate' },
    });

    expect(server.received[0]?.['accept-encoding']).toBe('identity');
  });

  it('does not let a configured User-Agent override ours', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await client()({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: { 'User-Agent': 'sneaky/1.0' },
    });

    expect(server.received[0]?.['user-agent']).toBe('api-watchdog/0.1');
  });

  it('keeps configured headers across a same-origin redirect', async () => {
    const server = await startServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { Location: '/next' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end();
    });

    await client(resolverFor({ 'monitor.test': [LOOPBACK] }))({
      target: target('monitor.test', server.port),
      timeoutMs: 2000,
      headers: { 'X-Trace-Id': 'keep-me' },
    });

    expect(server.received[1]?.['x-trace-id']).toBe('keep-me');
  });

  it('drops configured headers across a cross-origin redirect', async () => {
    const second = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const first = await startServer((_request, response) => {
      response.writeHead(302, {
        Location: `http://other.test:${String(second.port)}/moved`,
      });
      response.end();
    });
    testPorts.add(second.port);

    await client(resolverFor({ 'other.test': [LOOPBACK] }))({
      target: target('monitor.test', first.port),
      timeoutMs: 2000,
      headers: { 'X-Trace-Id': 'do-not-forward' },
    });

    // The user named one host; the header was not meant for wherever it points.
    expect(second.received[0]?.['x-trace-id']).toBeUndefined();
    expect(JSON.stringify(second.received[0])).not.toContain('do-not-forward');
    // Ours are still applied on the new hop.
    expect(second.received[0]?.['accept-encoding']).toBe('identity');
    expect(second.received[0]?.['user-agent']).toBe('api-watchdog/0.1');
  });

  it('never leaks a header value into the outcome or the console', async () => {
    const secretish = 'x-trace-value-9f3a';
    const logs: string[] = [];
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map(
      (method) =>
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(' '));
        }),
    );

    try {
      const server = await startServer((_request, response) => {
        response.destroy();
      });

      const outcome = await client()({
        target: target('monitor.test', server.port),
        timeoutMs: 2000,
        headers: { 'X-Trace-Id': secretish },
      });

      expect(JSON.stringify(outcome)).not.toContain(secretish);
      expect(logs.join('\n')).not.toContain(secretish);
      expect(logs).toHaveLength(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ── Module scope ────────────────────────────────────────────────────────────

describe('module scope', () => {
  const source = readFileSync(
    new URL('../src/checks/http-client.ts', import.meta.url),
    'utf8',
  );

  it('reads no configuration and has no permissive mode', () => {
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('loadConfig');
    expect(source).not.toContain('NODE_ENV');
  });

  it('uses node core http/https and no fetch or undici', () => {
    expect(source).toContain("from 'node:http'");
    expect(source).toContain("from 'node:https'");
    expect(source).not.toContain('undici');
    expect(source).not.toContain('fetch(');
  });

  it('introduces no persistence, endpoint, or scheduler code', () => {
    for (const forbidden of [
      'express',
      'Router',
      'INSERT',
      'check_results',
      'bullmq',
      'setInterval',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('does not enable automatic redirect following or connection pooling', () => {
    expect(source).toContain('agent: false');
    expect(source).not.toContain('keepAlive: true');
    // No library-style automatic redirect option: hops are followed by our own
    // loop, so each one can be revalidated.
    for (const option of [
      'maxRedirects',
      'maxRedirections',
      'followRedirect',
    ]) {
      expect(source).not.toContain(option);
    }
  });
});
