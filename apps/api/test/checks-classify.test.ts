import { describe, expect, it } from 'vitest';

import {
  type CheckAttempt,
  type CheckErrorType,
  classifyCheck,
} from '../src/checks/classify.js';
import type { ClientFailure } from '../src/checks/http-client.js';

const EXPECTED = 200;
const TIMEOUT = 5000;

/** A client outcome that arrived as an HTTP response. */
function responded(httpStatus: number, responseTimeMs = 42): CheckAttempt {
  return {
    stage: 'client',
    outcome: {
      ok: true,
      httpStatus,
      responseTimeMs,
      redirectCount: 0,
      finalUrl: 'https://example.com/',
    },
  };
}

/** A client outcome that failed before any response. */
function failedWith(failure: ClientFailure, responseTimeMs = 37): CheckAttempt {
  return {
    stage: 'client',
    outcome: { ok: false, failure, responseTimeMs, redirectCount: 0 },
  };
}

describe('expected-status comparison', () => {
  it('is a success only when the status matches exactly', () => {
    const result = classifyCheck(responded(200), EXPECTED, TIMEOUT);

    expect(result).toEqual({
      status: 'success',
      httpStatus: 200,
      responseTimeMs: 42,
      // The table's cross-column CHECK requires both to be null on success.
      errorType: null,
      errorMessage: null,
    });
  });

  it('honours a non-200 expected status', () => {
    expect(classifyCheck(responded(204), 204, TIMEOUT).status).toBe('success');
    expect(classifyCheck(responded(200), 204, TIMEOUT).status).toBe('failure');
    expect(classifyCheck(responded(301), 301, TIMEOUT).status).toBe('success');
  });

  it('records the actual status on a mismatch', () => {
    const result = classifyCheck(responded(503), EXPECTED, TIMEOUT);

    expect(result).toEqual({
      status: 'failure',
      // The one failure that carries a status: an exchange really happened.
      httpStatus: 503,
      responseTimeMs: 42,
      errorType: 'status_mismatch',
      errorMessage: 'Expected status 200, received 503',
    });
  });
});

describe('network and security failures', () => {
  const cases: [ClientFailure, CheckErrorType, string][] = [
    [{ kind: 'timeout' }, 'timeout', 'Timed out after 5000 ms'],
    [{ kind: 'dns' }, 'dns', 'Hostname could not be resolved'],
    [
      { kind: 'connection_refused' },
      'connection_refused',
      'Connection refused',
    ],
    [
      { kind: 'connection_error', code: 'ECONNRESET' },
      'connection_error',
      'Connection failed (ECONNRESET)',
    ],
    [{ kind: 'connection_error' }, 'connection_error', 'Connection failed'],
    [{ kind: 'tls', code: 'EPROTO' }, 'tls', 'TLS handshake failed (EPROTO)'],
    [
      { kind: 'too_many_redirects', detail: 'limit' },
      'too_many_redirects',
      'Exceeded 3 redirects',
    ],
    [
      { kind: 'too_many_redirects', detail: 'loop' },
      'too_many_redirects',
      'Redirect loop detected',
    ],
    [
      { kind: 'invalid_response', detail: 'header_limit' },
      'invalid_response',
      'Response headers exceeded limits',
    ],
    [
      { kind: 'invalid_response', detail: 'malformed' },
      'invalid_response',
      'Malformed HTTP response',
    ],
    [
      { kind: 'blocked_redirect', reason: 'scheme_not_allowed' },
      'blocked_url',
      'Redirect blocked: scheme_not_allowed',
    ],
    [
      { kind: 'blocked_redirect', reason: 'port_not_allowed' },
      'blocked_url',
      'Redirect blocked: port_not_allowed',
    ],
    [
      {
        kind: 'blocked_redirect',
        reason: 'address_not_allowed',
        detail: 'link_local',
      },
      'blocked_address',
      'Redirect blocked: address_not_allowed: link_local',
    ],
    [
      {
        kind: 'blocked_redirect',
        reason: 'blocked_address',
        detail: 'private',
      },
      'blocked_address',
      'Redirect blocked: blocked_address: private',
    ],
  ];

  it.each(cases)(
    'maps %j to the right classifier',
    (failure, errorType, errorMessage) => {
      const result = classifyCheck(failedWith(failure), EXPECTED, TIMEOUT);

      expect(result).toEqual({
        status: 'failure',
        // Never a sentinel: no HTTP exchange happened, so the column is null.
        httpStatus: null,
        responseTimeMs: 37,
        errorType,
        errorMessage,
      });
    },
  );

  it('never invents an http status for a non-HTTP failure', () => {
    for (const [failure] of cases) {
      expect(
        classifyCheck(failedWith(failure), EXPECTED, TIMEOUT).httpStatus,
      ).toBeNull();
    }
  });
});

describe('static guard rejections', () => {
  it('reports a URL-shape rejection as blocked_url with no elapsed time', () => {
    const result = classifyCheck(
      { stage: 'guard', result: { ok: false, reason: 'port_not_allowed' } },
      EXPECTED,
      TIMEOUT,
    );

    expect(result).toEqual({
      status: 'failure',
      httpStatus: null,
      // Nothing was attempted over the network.
      responseTimeMs: 0,
      errorType: 'blocked_url',
      errorMessage: 'Target rejected: port_not_allowed',
    });
  });

  it.each([
    'too_long',
    'unparseable',
    'scheme_not_allowed',
    'credentials_in_url',
    'no_hostname',
  ] as const)('reports %s as blocked_url', (reason) => {
    const result = classifyCheck(
      { stage: 'guard', result: { ok: false, reason } },
      EXPECTED,
      TIMEOUT,
    );

    expect(result.errorType).toBe('blocked_url');
    expect(result.responseTimeMs).toBe(0);
  });

  it('reports a rejected IP literal as blocked_address', () => {
    const result = classifyCheck(
      {
        stage: 'guard',
        result: {
          ok: false,
          reason: 'address_not_allowed',
          detail: 'link_local',
        },
      },
      EXPECTED,
      TIMEOUT,
    );

    expect(result.errorType).toBe('blocked_address');
    expect(result.errorMessage).toBe(
      'Target rejected: address_not_allowed: link_local',
    );
    expect(result.responseTimeMs).toBe(0);
  });
});

describe('resolution failures', () => {
  it('reports a resolution failure as dns with the elapsed time', () => {
    const result = classifyCheck(
      {
        stage: 'resolve',
        result: { ok: false, reason: 'dns' },
        elapsedMs: 12.6,
      },
      EXPECTED,
      TIMEOUT,
    );

    expect(result).toEqual({
      status: 'failure',
      httpStatus: null,
      responseTimeMs: 13,
      errorType: 'dns',
      errorMessage: 'Hostname could not be resolved',
    });
  });

  it('names the rejected address and the rule that rejected it', () => {
    const result = classifyCheck(
      {
        stage: 'resolve',
        result: {
          ok: false,
          reason: 'blocked_address',
          detail: 'link_local',
          address: '169.254.169.254',
        },
        elapsedMs: 5,
      },
      EXPECTED,
      TIMEOUT,
    );

    expect(result.errorType).toBe('blocked_address');
    expect(result.errorMessage).toBe(
      'Resolved address 169.254.169.254 is not allowed (link_local)',
    );
  });
});

describe('safe error-message construction', () => {
  it('drops an error code that does not look like one', () => {
    // The only value in a message we did not author. Anything outside the
    // charset is dropped rather than escaped, so no injected text can ride
    // along into a stored string.
    for (const code of [
      'not a code',
      '<script>alert(1)</script>',
      'ECONNRESET; DROP TABLE check_results',
      'x'.repeat(200),
      'lowercase',
      '',
    ]) {
      const result = classifyCheck(
        failedWith({ kind: 'connection_error', code }),
        EXPECTED,
        TIMEOUT,
      );

      expect(result.errorMessage).toBe('Connection failed');
    }
  });

  it('drops an address that is not an address', () => {
    const result = classifyCheck(
      {
        stage: 'resolve',
        result: {
          ok: false,
          reason: 'blocked_address',
          detail: 'private',
          address: 'not-an-address <b>',
        },
        elapsedMs: 1,
      },
      EXPECTED,
      TIMEOUT,
    );

    expect(result.errorMessage).toBe(
      'Resolved address is not allowed (private)',
    );
  });

  it('bounds every message to about 200 characters', () => {
    const result = classifyCheck(
      failedWith({ kind: 'connection_error', code: 'A'.repeat(31) }),
      EXPECTED,
      TIMEOUT,
    );

    expect(result.errorMessage?.length).toBeLessThanOrEqual(200);

    // And a deliberately huge expected status cannot stretch one either.
    const long = classifyCheck(responded(599), 12_345_678, TIMEOUT);
    expect(long.errorMessage?.length).toBeLessThanOrEqual(200);
  });
});

describe('response time handling', () => {
  it('always reports a non-negative integer', () => {
    const cases: CheckAttempt[] = [
      responded(200, 12.4),
      responded(200, 12.6),
      responded(200, -5),
      failedWith({ kind: 'timeout' }, 0),
      { stage: 'guard', result: { ok: false, reason: 'unparseable' } },
      { stage: 'resolve', result: { ok: false, reason: 'dns' }, elapsedMs: -1 },
    ];

    for (const attempt of cases) {
      const { responseTimeMs } = classifyCheck(attempt, EXPECTED, TIMEOUT);

      expect(Number.isInteger(responseTimeMs)).toBe(true);
      expect(responseTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('rounds rather than truncates', () => {
    expect(
      classifyCheck(responded(200, 12.6), EXPECTED, TIMEOUT).responseTimeMs,
    ).toBe(13);
  });
});
