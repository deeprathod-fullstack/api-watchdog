import type pg from 'pg';

import { NotFoundError } from '../errors.js';
import type { Monitor } from '../monitors/repository.js';
import {
  type CheckAttempt,
  type ClassifiedCheck,
  classifyCheck,
} from './classify.js';
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
 * The allowlisted projection of a check that may be logged.
 *
 * A closed shape rather than a loose object, so the only way to add a field to
 * a log line is to add it here, deliberately, in the one place where the rule
 * about what must never be logged is written down.
 */
export interface CheckLogFields {
  monitorId: string;
  /** Absent for a scheduled check: the worker's trust boundary is a monitor. */
  userId?: string;
  hostname: string;
  outcome: string;
  errorType: string | null;
  elapsedMs: number;
  /** What the check did to the monitor's incident state, when it ran one. */
  incident?: string;
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
export function logCheck(event: string, fields: CheckLogFields): void {
  // TODO(phase-4): replace with structured logging once that is introduced.
  const line = JSON.stringify({ event, ...fields });

  if (fields.errorType === 'blocked_address') {
    console.warn(line);
    return;
  }

  console.log(line);
}

/**
 * What `executeCheck` needs from a monitor.
 *
 * Named separately from `Monitor` so the shape of the contract is visible: a
 * URL, a budget, the headers to send, and the status that counts as healthy.
 * Ownership, name and schedule are none of the pipeline's business.
 */
export interface CheckableMonitor {
  readonly url: string;
  readonly expectedStatus: number;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Run one check and classify it. No database, no logging, no side effects.
 *
 * This is the whole of "check a monitor", shared verbatim by the manual
 * endpoint and the background worker. Having exactly one of these is the point:
 * the SSRF gate, the timeout, the redirect policy and the classification table
 * cannot be right on one path and wrong on the other, because there is only one
 * path. A second HTTP checker written for the worker would be a second place
 * for the guard to be forgotten.
 *
 * What the two callers differ in is what they do with the result — the endpoint
 * stores a row, the worker stores a row and moves an incident — and that
 * difference is theirs, not this function's.
 */
export async function executeCheck(
  executor: CheckExecutor,
  monitor: CheckableMonitor,
): Promise<ClassifiedCheck> {
  const start = process.hrtime.bigint();
  const elapsedMs = (): number =>
    Number(process.hrtime.bigint() - start) / 1_000_000;

  const attempt = await attemptCheck();

  return classifyCheck(attempt, monitor.expectedStatus, monitor.timeoutMs);

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
  const classified = await executeCheck(executor, monitor);

  let stored: CheckResult;
  try {
    stored = await insertCheckResult(db, monitor.id, classified);
  } catch (error) {
    if (error instanceof MonitorGoneError) {
      throw new NotFoundError('Monitor not found');
    }
    throw error;
  }

  logCheck('manual_check', {
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
}

/** Best-effort hostname for the log line; never throws on a bad URL. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unparseable';
  }
}
