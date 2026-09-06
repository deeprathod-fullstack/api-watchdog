import type pg from 'pg';

import type { ClassifiedCheck } from '../checks/classify.js';
import {
  type CheckResult,
  insertCheckResult,
  MonitorGoneError,
} from '../checks/repository.js';
import {
  currentFailureStreak,
  growIncident,
  type Incident,
  openIncident,
  resolveIncident,
} from './repository.js';

/**
 * When a run of failures becomes an incident.
 *
 * Three consecutive failures, so that one blip — a dropped packet, a restart, a
 * momentary 502 — is recorded in the history without being called an outage.
 *
 * A parameter with a default rather than a literal at the call site: the
 * threshold is a policy, and a policy written into the one call site that uses
 * it is a policy nobody can find. Every test below passes its own value, which
 * is how we know it is genuinely configurable and not just spelled as a
 * constant.
 */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** What recording a check did to this monitor's incident state. */
export type IncidentTransition =
  | { kind: 'none' }
  | { kind: 'opened'; incident: Incident }
  | { kind: 'ongoing'; incident: Incident }
  | { kind: 'resolved'; incident: Incident };

export interface RecordedCheck {
  check: CheckResult;
  transition: IncidentTransition;
}

/**
 * Store one check result and move the monitor's incident state with it.
 *
 * The two writes are one transaction because they are one fact. A check row
 * without its incident transition means an outage that started and was never
 * reported; an incident without the check that justifies it is an outage with
 * no evidence. Either would make the dashboard lie, and both are exactly what a
 * process killed between two statements would produce.
 *
 * The transaction also gives the two writes a single `now()`, so the check's
 * `checked_at` and the incident's `started_at` or `resolved_at` describe the
 * same instant rather than two that could be ordered wrongly.
 *
 * Everything here is derived from `check_results` and therefore idempotent in
 * the way that matters: the failure count is recomputed and *set*, never
 * incremented, so a redelivered job cannot inflate it.
 */
export async function recordCheck(
  pool: pg.Pool,
  monitorId: string,
  classified: ClassifiedCheck,
  threshold: number = DEFAULT_FAILURE_THRESHOLD,
): Promise<RecordedCheck> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const check = await insertCheckResult(client, monitorId, classified);
    const transition = await applyTransition(
      client,
      monitorId,
      check,
      threshold,
    );

    await client.query('COMMIT');

    return { check, transition };
  } catch (error) {
    // Roll back before anything else. A failed transaction left open would
    // hold its locks until the connection is returned to the pool and reused,
    // at which point the next caller inherits an aborted transaction.
    await client.query('ROLLBACK').catch(() => {
      // The connection is already unusable; the original error is the one
      // worth reporting, so this one is deliberately swallowed.
    });

    throw error;
  } finally {
    client.release();
  }
}

/** Decide and apply the incident move implied by one stored check. */
async function applyTransition(
  client: pg.PoolClient,
  monitorId: string,
  check: CheckResult,
  threshold: number,
): Promise<IncidentTransition> {
  if (check.status === 'success') {
    // One success ends an incident. Not a run of successes: the incident says
    // "this monitor was unreachable", and the moment it answers correctly
    // again, it no longer is. Waiting for confirmation would report every
    // recovery late, and a flapping endpoint is better described by a series
    // of short incidents than by one long one that hides the flapping.
    const incident = await resolveIncident(client, monitorId, check.checkedAt);

    return incident === null
      ? { kind: 'none' }
      : { kind: 'resolved', incident };
  }

  const streak = await currentFailureStreak(client, monitorId);

  if (streak.failures < threshold) {
    // Below the threshold there is nothing to record. The failures are already
    // in `check_results`, and if the streak continues they will be counted
    // into the incident that eventually opens — including these ones.
    return { kind: 'none' };
  }

  // The streak's first failure, not the one that crossed the threshold.
  // Downtime began when the monitor first stopped answering; dating the
  // incident from the threshold would under-report every outage by
  // (threshold - 1) intervals. `firstFailureAt` is non-null whenever the
  // streak is, since this very check is part of it.
  const startedAt = streak.firstFailureAt ?? check.checkedAt;

  const opened = await openIncident(
    client,
    monitorId,
    startedAt,
    streak.failures,
  );
  if (opened !== null) return { kind: 'opened', incident: opened };

  // The insert did nothing, so an incident was already open — either from an
  // earlier failure in this streak, or from a concurrent worker that got there
  // first. Both mean the same thing: update the one that exists.
  const ongoing = await growIncident(client, monitorId, streak.failures);

  return ongoing === null
    ? // Only reachable if the open incident was resolved between the two
      // statements, which nothing in this system does. Reporting no
      // transition is honest; inventing one would not be.
      { kind: 'none' }
    : { kind: 'ongoing', incident: ongoing };
}

export { MonitorGoneError };
