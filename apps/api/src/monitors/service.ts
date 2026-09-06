import type pg from 'pg';

import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { CheckScheduler } from '../queue/scheduler.js';
import {
  deleteMonitor,
  findMonitor,
  insertMonitor,
  listMonitors,
  MonitorConstraintError,
  type Monitor,
  TIMEOUT_INTERVAL_CONSTRAINT,
  updateMonitor,
} from './repository.js';
import type { CreateMonitorInput, PatchMonitorInput } from './schemas.js';

/**
 * Monitors one account may own.
 *
 * A cap is an abuse control, not a business tier: without it a single account
 * can fill the scheduler with work and make the list endpoint unbounded. It
 * also removes any need for pagination in V1.
 */
export const MAX_MONITORS_PER_USER = 20;

/** The only shape a monitor is serialised in. */
export interface MonitorResponse {
  id: string;
  name: string;
  url: string;
  method: string;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutMs: number;
  headers: Record<string, string>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Map a monitor to its API representation.
 *
 * `userId` is deliberately omitted: the caller can only ever see their own
 * monitors, so it carries no information, and a field that is never serialised
 * cannot leak when the row shape changes.
 */
export function toMonitorResponse(monitor: Monitor): MonitorResponse {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    expectedStatus: monitor.expectedStatus,
    intervalSeconds: monitor.intervalSeconds,
    timeoutMs: monitor.timeoutMs,
    headers: monitor.headers,
    active: monitor.active,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}

/**
 * Translate a constraint rejection into a client error.
 *
 * The database is the authority on the cross-column rule, because a partial
 * PATCH does not carry both values. Reaching here for *that* constraint means
 * the request was individually valid but invalid against the stored row — a
 * 400, not a 500.
 *
 * Any other constraint is not translated. It means the request schema and the
 * table have drifted apart, which is our bug: reporting it as a 500 makes it
 * visible in the logs (by constraint name, never by row content) instead of
 * telling the caller something false about their input.
 */
function asValidationError(error: unknown): never {
  if (
    error instanceof MonitorConstraintError &&
    error.constraint === TIMEOUT_INTERVAL_CONSTRAINT
  ) {
    throw new ValidationError(
      'timeoutMs must not exceed intervalSeconds * 1000',
    );
  }
  throw error;
}

/**
 * Bring a monitor's schedule in line with the row we just wrote.
 *
 * Scheduling failures are logged, never thrown. The write has already
 * committed, so turning a Redis hiccup into a 500 would tell the caller their
 * monitor was not created when it was — and leave them with no way to find out
 * otherwise. The honest failure mode is a monitor that exists but is not yet
 * scheduled, which `reconcileSchedules` repairs at the next API start.
 *
 * The monitor id is safe to log; nothing else about the monitor is touched.
 */
async function syncSchedule(
  scheduler: CheckScheduler,
  monitor: Monitor,
): Promise<void> {
  try {
    await scheduler.sync(monitor);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'schedule_sync_failed',
        monitorId: monitor.id,
        message: error instanceof Error ? error.message : 'unknown error',
      }),
    );
  }
}

export async function createMonitor(
  db: pg.Pool,
  scheduler: CheckScheduler,
  userId: string,
  input: CreateMonitorInput,
): Promise<MonitorResponse> {
  let monitor: Monitor | null;

  try {
    monitor = await insertMonitor(db, userId, input, MAX_MONITORS_PER_USER);
  } catch (error) {
    asValidationError(error);
  }

  if (!monitor) {
    throw new ConflictError(
      'monitor_limit_reached',
      `A user may own at most ${String(MAX_MONITORS_PER_USER)} monitors`,
    );
  }

  await syncSchedule(scheduler, monitor);

  return toMonitorResponse(monitor);
}

export async function getMonitors(
  db: pg.Pool,
  userId: string,
): Promise<MonitorResponse[]> {
  const monitors = await listMonitors(db, userId);

  return monitors.map(toMonitorResponse);
}

/**
 * Fetch one monitor, or 404.
 *
 * A monitor owned by someone else is reported as not found, never as
 * forbidden: a 403 would confirm the id exists, which is an enumeration oracle
 * over other users' data. "Not found" is true from this caller's perspective.
 */
export async function getMonitor(
  db: pg.Pool,
  userId: string,
  monitorId: string,
): Promise<MonitorResponse> {
  const monitor = await findMonitor(db, userId, monitorId);

  if (!monitor) throw new NotFoundError('Monitor not found');

  return toMonitorResponse(monitor);
}

/**
 * Which patches can change a schedule?
 *
 * Only these two fields define one, so a patch that mentions neither cannot
 * possibly need the scheduler touched. Checking this is not an optimisation —
 * an upsert restarts the scheduler's timer, so re-syncing on an unrelated
 * rename would push the monitor's next check up to a full interval away. A
 * rename must not delay a check.
 *
 * Everything else the worker needs — URL, headers, timeout, expected status —
 * is read from PostgreSQL at execution time, so those changes take effect on
 * the next run with no scheduling work at all.
 */
function affectsSchedule(patch: PatchMonitorInput): boolean {
  return patch.active !== undefined || patch.intervalSeconds !== undefined;
}

export async function patchMonitor(
  db: pg.Pool,
  scheduler: CheckScheduler,
  userId: string,
  monitorId: string,
  patch: PatchMonitorInput,
): Promise<MonitorResponse> {
  let monitor: Monitor | null;

  try {
    monitor = await updateMonitor(db, userId, monitorId, patch);
  } catch (error) {
    asValidationError(error);
  }

  if (!monitor) throw new NotFoundError('Monitor not found');

  if (affectsSchedule(patch)) {
    // `sync` reads `active` off the updated row, so pause, resume and an
    // interval change are all handled by this one call.
    await syncSchedule(scheduler, monitor);
  }

  return toMonitorResponse(monitor);
}

export async function removeMonitor(
  db: pg.Pool,
  scheduler: CheckScheduler,
  userId: string,
  monitorId: string,
): Promise<void> {
  const deleted = await deleteMonitor(db, userId, monitorId);

  if (!deleted) throw new NotFoundError('Monitor not found');

  // Removed after the delete commits, never before: a schedule for a monitor
  // that still exists would stop it being checked, whereas a schedule left
  // behind for a deleted one is harmless — the worker reloads from PostgreSQL,
  // finds nothing, and does nothing. Reconciliation clears it later.
  try {
    await scheduler.remove(monitorId);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'schedule_remove_failed',
        monitorId,
        message: error instanceof Error ? error.message : 'unknown error',
      }),
    );
  }
}
