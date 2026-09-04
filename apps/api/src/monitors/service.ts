import type pg from 'pg';

import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
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

export async function createMonitor(
  db: pg.Pool,
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

export async function patchMonitor(
  db: pg.Pool,
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

  return toMonitorResponse(monitor);
}

export async function removeMonitor(
  db: pg.Pool,
  userId: string,
  monitorId: string,
): Promise<void> {
  const deleted = await deleteMonitor(db, userId, monitorId);

  if (!deleted) throw new NotFoundError('Monitor not found');
}
