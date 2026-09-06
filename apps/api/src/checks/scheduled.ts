import type pg from 'pg';

import { recordCheck } from '../incidents/engine.js';
import { findMonitorById } from '../monitors/repository.js';
import { MonitorGoneError } from './repository.js';
import {
  type CheckExecutor,
  executeCheck,
  hostnameOf,
  logCheck,
} from './service.js';

/**
 * One scheduled check, from a monitor id to a stored result.
 *
 * Separate from the worker process so that the *behaviour* can be tested
 * without starting a Worker, connecting to Redis, or waiting for a timer to
 * fire. `worker.ts` supplies the plumbing; this supplies the decisions.
 */

/** Why a job did nothing, or what it did. */
export type ScheduledCheckOutcome =
  | { kind: 'gone' }
  | { kind: 'paused' }
  | { kind: 'checked'; status: 'success' | 'failure'; incident: string };

/**
 * Execute the check for one monitor id.
 *
 * The monitor id is the worker's entire trust boundary. Everything else is read
 * back from PostgreSQL here, immediately before the check runs, which is what
 * makes the following three properties true rather than merely likely:
 *
 *  - a monitor deleted after its job was queued is not checked
 *  - a monitor paused after its job was queued is not checked
 *  - a monitor edited after its job was queued is checked with the new settings
 *
 * A job payload carrying the URL and headers could not offer any of them.
 */
export async function runScheduledCheck(
  db: pg.Pool,
  executor: CheckExecutor,
  monitorId: string,
): Promise<ScheduledCheckOutcome> {
  const monitor = await findMonitorById(db, monitorId);

  // The monitor was deleted between the job being scheduled and being run. Not
  // an error: the schedule is removed on delete, and a job already in flight
  // simply has nothing left to do. Reconciliation clears any stale schedule.
  if (monitor === null) return { kind: 'gone' };

  // Paused is checked here, on the current row, and not at enqueue time. The
  // schedule is removed when a monitor is paused, so this is the second line of
  // defence — for the job that was already in the queue at that moment, and for
  // a schedule that outlived a failed removal.
  if (!monitor.active) return { kind: 'paused' };

  const classified = await executeCheck(executor, monitor);

  try {
    const { transition } = await recordCheck(db, monitor.id, classified);

    logCheck('scheduled_check', {
      monitorId: monitor.id,
      // The hostname only; never the full URL, and never a header name or
      // value. This is the only log line a scheduled check produces.
      hostname: hostnameOf(monitor.url),
      outcome: classified.status,
      errorType: classified.errorType,
      elapsedMs: classified.responseTimeMs,
      incident: transition.kind,
    });

    return {
      kind: 'checked',
      status: classified.status,
      incident: transition.kind,
    };
  } catch (error) {
    // The monitor was deleted while its own check was in flight. The
    // transaction rolled back, so nothing was written, and there is nothing to
    // report — exactly the 'gone' case, discovered later.
    if (error instanceof MonitorGoneError) return { kind: 'gone' };

    throw error;
  }
}
