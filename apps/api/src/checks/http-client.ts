import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { type AddressRejection } from './ip-rules.js';
import {
  pinnedLookup,
  type ResolvedAddress,
  type SafeResolution,
} from './safe-lookup.js';
import {
  guardUrl,
  type UrlGuardResult,
  type UrlRejection,
} from './url-guard.js';

/**
 * The outbound request layer.
 *
 * Two decisions shape everything here.
 *
 * **Pinning happens through the socket's `lookup` hook, never by rewriting the
 * URL's host.** Replacing the hostname with the validated IP would force us to
 * hand-fix the `Host` header, hand-set SNI, and then — the classic next step —
 * disable certificate verification because the certificate does not match an
 * IP address. Instead the request keeps `host: <hostname>` and only `lookup` is
 * overridden, so Node produces the correct `Host`, the correct SNI, and a
 * certificate check against the real hostname, while the socket connects to an
 * address {@link resolveSafely} already approved.
 *
 * **Connection reuse is off** (`agent: false`). A pooled keep-alive socket from
 * an earlier check could be handed to a later request for a different
 * hostname, which would route a validated-hostname request over a socket
 * pinned somewhere else. That is a pinning bypass through the agent.
 *
 * This module reads no configuration and no environment variables, has no
 * permissive mode, never weakens TLS certificate verification, never reads a
 * response body, and never logs. It returns data; the caller decides what to
 * record.
 */

/** Redirects we follow. Every other 3xx is a final response. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const MAX_REDIRECTS = 3;

/** Response header limits, so a hostile peer cannot exhaust memory. */
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADER_COUNT = 100;

const USER_AGENT = 'api-watchdog/0.1';

/**
 * Headers the client owns outright.
 *
 * A configured monitor header with any of these names is dropped before the
 * owned values are assigned, so ownership does not depend on the order of an
 * object spread — a `Host: evil.example` in a monitor's configuration cannot
 * redirect our request, and `Accept-Encoding: gzip` cannot re-enable a
 * compressed body we have no intention of reading.
 */
const CLIENT_OWNED_HEADERS = new Set(['host', 'accept-encoding', 'user-agent']);

const SCHEME_DEFAULT_PORT: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

/** A target whose URL and addresses have already passed the SSRF gate. */
export interface CheckTarget {
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly addresses: readonly ResolvedAddress[];
}

export interface CheckRequest {
  readonly target: CheckTarget;
  /** Total budget for the whole operation, including every redirect hop. */
  readonly timeoutMs: number;
  /** The monitor's configured non-secret headers. */
  readonly headers: Readonly<Record<string, string>>;
}

export type ClientFailure =
  | { kind: 'timeout' }
  | { kind: 'dns' }
  | { kind: 'connection_refused' }
  | { kind: 'connection_error'; code?: string }
  | { kind: 'tls'; code?: string }
  | { kind: 'too_many_redirects'; detail: 'limit' | 'loop' }
  | { kind: 'invalid_response'; detail: 'header_limit' | 'malformed' }
  | {
      kind: 'blocked_redirect';
      reason: UrlRejection | 'blocked_address';
      detail?: AddressRejection;
    };

/**
 * The result of one outbound check.
 *
 * `ok: true` means an HTTP response arrived — not that the check passed.
 * Comparing `httpStatus` with the monitor's expected status belongs to the
 * caller, which is what keeps this module ignorant of what a monitor is.
 */
export type CheckOutcome =
  | {
      ok: true;
      httpStatus: number;
      responseTimeMs: number;
      redirectCount: number;
      finalUrl: string;
    }
  | {
      ok: false;
      failure: ClientFailure;
      responseTimeMs: number;
      redirectCount: number;
    };

/** The Phase B boundary, injected so tests can drive every DNS outcome. */
export type SafeResolve = (hostname: string) => Promise<SafeResolution>;

/** The Phase A boundary. Defaults to the real policy; see the note below. */
export type UrlGuard = (url: string) => UrlGuardResult;

export interface CheckClientDependencies {
  readonly resolve: SafeResolve;
  /**
   * The static URL policy applied to every redirect target.
   *
   * Defaults to the real {@link guardUrl}, so production wiring cannot forget
   * it by omission. It is injectable only because the production port policy
   * (80/443 only) makes a redirect to a test server on an ephemeral port
   * unreachable, and redirect behaviour is worth exercising over real sockets.
   */
  readonly guard?: UrlGuard;
}

/** Bracket an IPv6 literal for use in a `Host` header. */
function hostHeaderValue(target: CheckTarget): string {
  const scheme = new URL(target.url).protocol;
  const host =
    net.isIPv6(target.hostname) === true || net.isIP(target.hostname) === 6
      ? `[${target.hostname}]`
      : target.hostname;

  return target.port === SCHEME_DEFAULT_PORT[scheme]
    ? host
    : `${host}:${String(target.port)}`;
}

/**
 * Build the outgoing header set: configured headers first, with the
 * client-owned names removed, then the owned values assigned explicitly.
 */
function buildHeaders(
  target: CheckTarget,
  configured: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(configured)) {
    if (CLIENT_OWNED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }

  headers.Host = hostHeaderValue(target);
  // We never read a body, so we certainly do not want a compressed one.
  headers['Accept-Encoding'] = 'identity';
  headers['User-Agent'] = USER_AGENT;

  return headers;
}

/** Map a socket/TLS/parser error onto the classifier's vocabulary. */
function classifyError(error: unknown): ClientFailure {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  const name =
    error instanceof Error && typeof error.name === 'string'
      ? error.name
      : undefined;

  if (
    code === 'ABORT_ERR' ||
    name === 'AbortError' ||
    name === 'TimeoutError'
  ) {
    return { kind: 'timeout' };
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return { kind: 'timeout' };
  }

  if (code === 'ECONNREFUSED') return { kind: 'connection_refused' };

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns' };

  if (code === 'HPE_HEADER_OVERFLOW') {
    return { kind: 'invalid_response', detail: 'header_limit' };
  }

  if (code?.startsWith('HPE_') === true) {
    return { kind: 'invalid_response', detail: 'malformed' };
  }

  if (
    code === 'EPROTO' ||
    code?.startsWith('ERR_TLS') === true ||
    code?.startsWith('ERR_SSL') === true ||
    code?.includes('CERT') === true ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'ERR_SOCKET_BAD_PORT'
  ) {
    // Only the code travels, never the driver's message: TLS errors quote
    // certificate details, and a raw message is exactly what must not reach a
    // stored classifier or a log line.
    return { kind: 'tls', code };
  }

  return { kind: 'connection_error', code };
}

type HopResult =
  | {
      kind: 'response';
      status: number;
      location: string | null;
      /** Elapsed ms at the response's first byte. */
      at: number;
    }
  | { kind: 'failure'; failure: ClientFailure; at: number };

/**
 * Perform one hop and stop at the response headers.
 *
 * No `'data'` listener is ever attached: the status arrives with the headers,
 * and both response and request are destroyed immediately afterwards. Because
 * the body is never read there is no size limit to get wrong, no decompression
 * bomb, and no slow-body socket to hold open.
 */
function performHop(
  target: CheckTarget,
  headers: Record<string, string>,
  remainingMs: number,
  now: () => number,
): Promise<HopResult> {
  return new Promise((resolve) => {
    const parsed = new URL(target.url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    let settled = false;
    const finish = (result: HopResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = transport.request({
      // The real hostname stays here, which is what keeps `Host`, SNI and
      // certificate verification correct while `lookup` pins the address.
      host: target.hostname,
      port: target.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers,
      // No connection pooling: a reused socket could be pinned elsewhere.
      agent: false,
      lookup: pinnedLookup(target.addresses),
      // One hop gets only what is left of the total budget.
      signal: AbortSignal.timeout(remainingMs),
      maxHeaderSize: MAX_HEADER_BYTES,
      ...(isHttps ? { servername: target.hostname } : {}),
    });

    request.on('response', (response) => {
      const at = now();
      const status = response.statusCode ?? 0;
      const location =
        typeof response.headers.location === 'string'
          ? response.headers.location
          : null;
      const headerCount = response.rawHeaders.length / 2;

      // Take nothing but the headers, then close the connection.
      response.destroy();
      request.destroy();

      if (headerCount > MAX_HEADER_COUNT) {
        finish({
          kind: 'failure',
          failure: { kind: 'invalid_response', detail: 'header_limit' },
          at,
        });
        return;
      }

      if (status < 100 || status > 599) {
        finish({
          kind: 'failure',
          failure: { kind: 'invalid_response', detail: 'malformed' },
          at,
        });
        return;
      }

      finish({ kind: 'response', status, location, at });
    });

    // Errors arriving after we already have an answer (the ECONNRESET our own
    // destroy provokes) are ignored by the `settled` guard.
    request.on('error', (error) => {
      finish({ kind: 'failure', failure: classifyError(error), at: now() });
    });

    request.end();
  });
}

/** Race work against the remaining budget without restarting it. */
async function withinBudget<T>(
  work: Promise<T>,
  remainingMs: number,
): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;

  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), remainingMs);
  });

  try {
    // `work` may still settle later; it holds no resources we need to reclaim
    // (a DNS lookup), and its result is discarded.
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the check client.
 *
 * The returned function performs a check against an already-validated target
 * and resolves with a structured outcome. It never throws for a network or
 * policy failure — those are results, not exceptions.
 */
export function createCheckClient(
  dependencies: CheckClientDependencies,
): (request: CheckRequest) => Promise<CheckOutcome> {
  const { resolve, guard = guardUrl } = dependencies;

  return async (request) => {
    // One monotonic start, one deadline. `remaining` is always
    // `timeoutMs - elapsed`, so nothing anywhere can restart the budget: not a
    // redirect hop, not a DNS lookup.
    const start = process.hrtime.bigint();
    const elapsed = (): number =>
      Number(process.hrtime.bigint() - start) / 1_000_000;
    const remaining = (): number => request.timeoutMs - elapsed();
    const asMs = (value: number): number => Math.max(0, Math.round(value));
    /**
     * The remaining budget as a whole number of milliseconds.
     *
     * `AbortSignal.timeout` and `setTimeout` both require an integer delay, and
     * `remaining()` is a fractional monotonic measurement. Rounded *up* so the
     * budget is never silently shortened, and floored at 1 because a zero delay
     * would fire before the request could start — the `remaining() <= 0` checks
     * are what actually stop an exhausted budget.
     */
    const budgetMs = (): number => Math.max(1, Math.ceil(remaining()));

    let target = request.target;
    let configured = request.headers;
    const visited = new Set([target.url]);

    for (let hop = 0; ; hop += 1) {
      if (remaining() <= 0) {
        return {
          ok: false,
          failure: { kind: 'timeout' },
          responseTimeMs: asMs(elapsed()),
          redirectCount: hop,
        };
      }

      const result = await performHop(
        target,
        buildHeaders(target, configured),
        budgetMs(),
        elapsed,
      );

      if (result.kind === 'failure') {
        return {
          ok: false,
          failure: result.failure,
          responseTimeMs: asMs(result.at),
          redirectCount: hop,
        };
      }

      const isRedirect =
        REDIRECT_STATUSES.has(result.status) && result.location !== null;

      if (!isRedirect) {
        return {
          ok: true,
          httpStatus: result.status,
          responseTimeMs: asMs(result.at),
          redirectCount: hop,
          finalUrl: target.url,
        };
      }

      const failure = (value: ClientFailure): CheckOutcome => ({
        ok: false,
        failure: value,
        responseTimeMs: asMs(elapsed()),
        redirectCount: hop,
      });

      if (hop >= MAX_REDIRECTS) {
        return failure({ kind: 'too_many_redirects', detail: 'limit' });
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(result.location ?? '', target.url).href;
      } catch {
        return failure({ kind: 'invalid_response', detail: 'malformed' });
      }

      // A redirect target is a brand-new untrusted URL: the full gate runs
      // again, every hop, with no shortcut for a same-origin hop.
      const guarded = guard(nextUrl);
      if (!guarded.ok) {
        return failure({
          kind: 'blocked_redirect',
          reason: guarded.reason,
          ...(guarded.detail === undefined ? {} : { detail: guarded.detail }),
        });
      }

      if (visited.has(guarded.target.url)) {
        return failure({ kind: 'too_many_redirects', detail: 'loop' });
      }
      visited.add(guarded.target.url);

      if (remaining() <= 0) return failure({ kind: 'timeout' });

      const resolution = await withinBudget(
        resolve(guarded.target.hostname),
        budgetMs(),
      );

      if (resolution === 'timeout') return failure({ kind: 'timeout' });

      if (!resolution.ok) {
        return resolution.reason === 'dns'
          ? failure({ kind: 'dns' })
          : failure({
              kind: 'blocked_redirect',
              reason: 'blocked_address',
              detail: resolution.detail,
            });
      }

      // The user named one host; their headers were not meant for whatever
      // that host redirects to.
      const crossOrigin =
        new URL(guarded.target.url).origin !== new URL(target.url).origin;
      if (crossOrigin) configured = {};

      target = {
        url: guarded.target.url,
        hostname: guarded.target.hostname,
        port: guarded.target.port,
        // A fresh pinned set for this hop, never the previous hop's.
        addresses: resolution.addresses,
      };
    }
  };
}
