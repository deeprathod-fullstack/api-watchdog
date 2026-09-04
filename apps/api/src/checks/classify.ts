import net from 'node:net';

import type { CheckOutcome } from './http-client.js';
import type { AddressRejection } from './ip-rules.js';
import type { SafeResolution } from './safe-lookup.js';
import type { UrlGuardResult, UrlRejection } from './url-guard.js';

/**
 * Turn the result of a check attempt into the row we store.
 *
 * Pure on purpose: every classification decision lives here, so the whole
 * mapping table is testable with no database, no sockets and no clock. The
 * service does I/O and makes no decisions; this module makes decisions and does
 * no I/O.
 */

/** The closed set of classifiers `check_results.error_type` may hold. */
export type CheckErrorType =
  | 'status_mismatch'
  | 'timeout'
  | 'dns'
  | 'connection_refused'
  | 'connection_error'
  | 'tls'
  | 'blocked_url'
  | 'blocked_address'
  | 'too_many_redirects'
  | 'invalid_response'
  | 'unknown';

/** Roughly the length the column is worth holding for a display string. */
const MAX_ERROR_MESSAGE = 200;

/** How far the client will follow redirects, for the message text only. */
const REDIRECT_LIMIT = 3;

/** What happened, at whichever stage the attempt stopped. */
export type CheckAttempt =
  | {
      /** The static URL policy rejected the target; no network work happened. */
      stage: 'guard';
      result: Extract<UrlGuardResult, { ok: false }>;
    }
  | {
      /** DNS resolution failed or produced an address we refuse to contact. */
      stage: 'resolve';
      result: Extract<SafeResolution, { ok: false }>;
      elapsedMs: number;
    }
  | { stage: 'client'; outcome: CheckOutcome };

/** Exactly the columns `check_results` needs. */
export interface ClassifiedCheck {
  status: 'success' | 'failure';
  httpStatus: number | null;
  responseTimeMs: number;
  errorType: CheckErrorType | null;
  errorMessage: string | null;
}

/** Clamp to the column's contract: a non-negative whole number of ms. */
function asMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function truncate(message: string): string {
  return message.length <= MAX_ERROR_MESSAGE
    ? message
    : `${message.slice(0, MAX_ERROR_MESSAGE - 1)}…`;
}

/**
 * Allow an error code into a message only if it looks like an error code.
 *
 * Codes originate from Node and the operating system rather than from the
 * monitored host, but this is the one place where a value we did not author
 * reaches a stored string, so it is checked against a charset rather than
 * trusted. Anything else is dropped, not escaped.
 */
function safeCode(code: string | undefined): string | null {
  if (code === undefined) return null;

  return /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : null;
}

/** Interpolate an address only when it really is one. */
function safeAddress(address: string): string | null {
  return net.isIP(address) === 0 ? null : address;
}

function withCode(text: string, code: string | undefined): string {
  const usable = safeCode(code);

  return usable === null ? text : `${text} (${usable})`;
}

/**
 * Does this rejection describe an address, or the URL's shape?
 *
 * `address_not_allowed` comes from an IP literal written directly into the URL,
 * which is an address decision even though the static guard made it.
 */
function isAddressRejection(reason: UrlRejection | 'blocked_address'): boolean {
  return reason === 'blocked_address' || reason === 'address_not_allowed';
}

function blockedMessage(
  reason: UrlRejection | 'blocked_address',
  detail: AddressRejection | undefined,
  prefix: string,
): string {
  const rule = detail === undefined ? reason : `${reason}: ${detail}`;

  return `${prefix} ${rule}`;
}

/**
 * Classify an attempt.
 *
 * `expectedStatus` and `timeoutMs` come from the monitor; nothing else about
 * the monitor is needed, and in particular its headers and URL never reach a
 * stored message.
 */
export function classifyCheck(
  attempt: CheckAttempt,
  expectedStatus: number,
  timeoutMs: number,
): ClassifiedCheck {
  if (attempt.stage === 'guard') {
    const { reason, detail } = attempt.result;

    return {
      status: 'failure',
      // No HTTP exchange happened, so there is no status to record. NULL is
      // the truth; a sentinel like 0 or 599 would corrupt every future
      // aggregate built on this column.
      httpStatus: null,
      // Nothing was attempted over the network: not a measurement of zero, an
      // absence of one.
      responseTimeMs: 0,
      errorType: isAddressRejection(reason) ? 'blocked_address' : 'blocked_url',
      errorMessage: truncate(
        blockedMessage(reason, detail, 'Target rejected:'),
      ),
    };
  }

  if (attempt.stage === 'resolve') {
    const elapsed = asMs(attempt.elapsedMs);

    if (attempt.result.reason === 'dns') {
      return {
        status: 'failure',
        httpStatus: null,
        responseTimeMs: elapsed,
        errorType: 'dns',
        errorMessage: 'Hostname could not be resolved',
      };
    }

    const address = safeAddress(attempt.result.address);
    const detail = attempt.result.detail;

    return {
      status: 'failure',
      httpStatus: null,
      responseTimeMs: elapsed,
      errorType: 'blocked_address',
      errorMessage: truncate(
        address === null
          ? `Resolved address is not allowed (${detail})`
          : `Resolved address ${address} is not allowed (${detail})`,
      ),
    };
  }

  const { outcome } = attempt;
  const responseTimeMs = asMs(outcome.responseTimeMs);

  if (outcome.ok) {
    if (outcome.httpStatus === expectedStatus) {
      // The table's cross-column CHECK requires both error columns to be NULL
      // on a success, and a success genuinely has nothing to say.
      return {
        status: 'success',
        httpStatus: outcome.httpStatus,
        responseTimeMs,
        errorType: null,
        errorMessage: null,
      };
    }

    return {
      status: 'failure',
      // The one failure that does carry a status: the exchange happened.
      httpStatus: outcome.httpStatus,
      responseTimeMs,
      errorType: 'status_mismatch',
      errorMessage: `Expected status ${String(expectedStatus)}, received ${String(outcome.httpStatus)}`,
    };
  }

  const failure = outcome.failure;

  const asFailure = (
    errorType: CheckErrorType,
    errorMessage: string,
  ): ClassifiedCheck => ({
    status: 'failure',
    httpStatus: null,
    responseTimeMs,
    errorType,
    errorMessage: truncate(errorMessage),
  });

  switch (failure.kind) {
    case 'timeout':
      return asFailure('timeout', `Timed out after ${String(timeoutMs)} ms`);

    case 'dns':
      return asFailure('dns', 'Hostname could not be resolved');

    case 'connection_refused':
      return asFailure('connection_refused', 'Connection refused');

    case 'connection_error':
      return asFailure(
        'connection_error',
        withCode('Connection failed', failure.code),
      );

    case 'tls':
      return asFailure('tls', withCode('TLS handshake failed', failure.code));

    case 'too_many_redirects':
      return asFailure(
        'too_many_redirects',
        failure.detail === 'loop'
          ? 'Redirect loop detected'
          : `Exceeded ${String(REDIRECT_LIMIT)} redirects`,
      );

    case 'invalid_response':
      return asFailure(
        'invalid_response',
        failure.detail === 'header_limit'
          ? 'Response headers exceeded limits'
          : 'Malformed HTTP response',
      );

    case 'blocked_redirect':
      return asFailure(
        isAddressRejection(failure.reason) ? 'blocked_address' : 'blocked_url',
        blockedMessage(failure.reason, failure.detail, 'Redirect blocked:'),
      );

    default: {
      // Exhaustiveness: a new failure kind is a compile error here rather than
      // a silent `unknown` in the data.
      const unexpected: never = failure;
      void unexpected;

      return asFailure('unknown', 'Check failed for an unknown reason');
    }
  }
}
