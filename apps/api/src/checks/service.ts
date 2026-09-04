import type pg from 'pg';

import { NotFoundError } from '../errors.js';
import type { Monitor } from '../monitors/repository.js';
import { type CheckAttempt, classifyCheck } from './classify.js';
import type {
  CheckOutcome,
  CheckRequest,
  SafeResolve,
  UrlGuard,
} from './http-client.js';
import {
  type CheckResult,
  insertCheckResult,
  MonitorGoneError,
} from './repository.js';

/**
 * Runs one manual check: guard the stored URL, resolve it safely, make the
 * request, classify the outcome, store exactly one row.
 *
 * The three collaborators are injected together. In production they are the
 * real static guard, the real resolver and the real client; tests supply the
 * same triple pointed at a local server. No environment variable selects
 * between them, and the production wiring lives in the process entry point.
 *
 * Note what this module does *not* contain: redirect handling. Hops are the
 * client's business, including the per-hop guard and resolve, so the policy
 * exists in exactly one place.
 */
export interface CheckExecutor {
  readonly guard: UrlGuard;
  readonly resolve: SafeResolve;
  readonly client: (request: CheckRequest) => Promise<CheckOutcome>;
}

/** The API representation of a stored check. */
export interface CheckResultResponse {
  id: string;
  monitorId: string;
  status: 'success' | 'failure';
  httpStatus: number | null;
  responseTimeMs: number;
  errorType: string | null;
  errorMessage: string | null;
  checkedAt: string;
}

export function toCheckResultResponse(check: CheckResult): CheckResultResponse {
  return {
    id: check.id,
    monitorId: check.monitorId,
    status: check.status,
    httpStatus: check.httpStatus,
    responseTimeMs: check.responseTimeMs,
    errorType: check.errorType,
    errorMessage: check.errorMessage,
    checkedAt: check.checkedAt.toISOString(),
  };
}

/**
 * Log one line per check, from an allowlisted projection.
 *
 * Only these fields, ever. The monitor object, its URL, its headers, any header
 * value, a response body and any raw Node error are all absent by
 * construction — this is the only logging statement in the check pipeline, and
 * the modules it calls import no logger at all.
 *
 * A blocked address is logged at warn: a rise in those is a security signal
 * worth seeing, not routine noise.
 */
function logCheck(fields: {
  monitorId: string;
  userId: string;
  hostname: string;
  outcome: string;
  errorType: string | null;
  elapsedMs: number;
}): void {
  // TODO(phase-4): replace with structured logging once that is introduced.
  const line = JSON.stringify({ event: 'manual_check', ...fields });

  if (fields.errorType === 'blocked_address') {
    console.warn(line);
    return;
  }

  console.log(line);
}

/**
 * Execute and persist a manual check for a monitor the caller already owns.
 *
 * Authentication, ownership and rate limiting happen before this is called;
 * `monitor` is the row from the owner-scoped query. A paused monitor is checked
 * normally — pause governs the future scheduler, not this endpoint.
 */
export async function runManualCheck(
  db: pg.Pool,
  executor: CheckExecutor,
  monitor: Monitor,
  userId: string,
): Promise<CheckResult> {
  const start = process.hrtime.bigint();
  const elapsedMs = (): number =>
    Number(process.hrtime.bigint() - start) / 1_000_000;

  const attempt = await attemptCheck();

  const classified = classifyCheck(
    attempt,
    monitor.expectedStatus,
    monitor.timeoutMs,
  );

  let stored: CheckResult;
  try {
    stored = await insertCheckResult(db, monitor.id, classified);
  } catch (error) {
    if (error instanceof MonitorGoneError) {
      throw new NotFoundError('Monitor not found');
    }
    throw error;
  }

  logCheck({
    monitorId: monitor.id,
    userId,
    // The hostname only; never the full URL, whose path and query are the
    // user's and which a regressed guard could carry credentials in.
    hostname: hostnameOf(monitor.url),
    outcome: classified.status,
    errorType: classified.errorType,
    elapsedMs: classified.responseTimeMs,
  });

  return stored;

  /** Walk the pipeline, stopping at the first stage that refuses. */
  async function attemptCheck(): Promise<CheckAttempt> {
    // No outbound packet may be sent before both of these pass.
    const guarded = executor.guard(monitor.url);
    if (!guarded.ok) return { stage: 'guard', result: guarded };

    const resolution = await executor.resolve(guarded.target.hostname);
    if (!resolution.ok) {
      return { stage: 'resolve', result: resolution, elapsedMs: elapsedMs() };
    }

    const outcome = await executor.client({
      target: {
        url: guarded.target.url,
        hostname: guarded.target.hostname,
        port: guarded.target.port,
        addresses: resolution.addresses,
      },
      timeoutMs: monitor.timeoutMs,
      headers: monitor.headers,
    });

    return { stage: 'client', outcome };
  }
}

/** Best-effort hostname for the log line; never throws on a bad URL. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unparseable';
  }
}
