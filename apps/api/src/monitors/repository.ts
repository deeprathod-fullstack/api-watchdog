import type pg from 'pg';

import type { CreateMonitorInput, PatchMonitorInput } from './schemas.js';

/** A `monitors` row as PostgreSQL returns it. */
interface MonitorRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  interval_seconds: number;
  timeout_ms: number;
  headers: Record<string, string>;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A monitor as the rest of the application sees it. */
export interface Monitor {
  id: string;
  userId: string;
  name: string;
  url: string;
  method: string;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutMs: number;
  headers: Record<string, string>;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A write was rejected by a table CHECK constraint.
 *
 * `constraint` is the constraint's name, which is what lets the caller
 * distinguish the one violation the request schema cannot pre-empt from a
 * genuine mismatch between the schema and the table.
 *
 * Only the name is carried, never the driver's error: PostgreSQL's DETAIL for
 * a CHECK violation is `Failing row contains (...)`, i.e. the whole row —
 * header values included. Letting that reach the logger would violate the rule
 * that header values are never logged.
 */
export class MonitorConstraintError extends Error {
  override readonly name = 'MonitorConstraintError';
  readonly constraint: string;

  constructor(constraint: string) {
    super(`Monitor violates constraint ${constraint}`);
    this.constraint = constraint;
  }
}

/** SQLSTATE for a CHECK constraint violation. */
const CHECK_VIOLATION = '23514';

/**
 * The cross-column rule `timeout_ms <= interval_seconds * 1000`.
 *
 * The only constraint a validated request can still violate, because a partial
 * PATCH does not carry both values.
 */
export const TIMEOUT_INTERVAL_CONSTRAINT = 'monitors_chck';

/** Columns every statement returns, so one mapper covers all of them. */
const RETURNED_COLUMNS = `id, user_id, name, url, method, expected_status,
          interval_seconds, timeout_ms, headers, active, created_at, updated_at`;

function toMonitor(row: MonitorRow): Monitor {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    url: row.url,
    method: row.method,
    expectedStatus: row.expected_status,
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    headers: row.headers,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Re-throw a CHECK violation as a domain error naming the constraint, and
 * anything else untouched.
 */
function rethrowConstraintViolation(error: unknown): never {
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === CHECK_VIOLATION
  ) {
    const constraint =
      'constraint' in error && typeof error.constraint === 'string'
        ? error.constraint
        : 'unknown';

    throw new MonitorConstraintError(constraint);
  }

  throw error;
}

/**
 * Insert a monitor, unless the owner is already at their cap.
 *
 * The cap is enforced *inside* the INSERT rather than by a preceding
 * `SELECT count(*)`: a read-then-write check is a race, and two simultaneous
 * creates would both see room and both succeed. `INSERT ... SELECT ... WHERE
 * (SELECT count(*) ...) < $n` makes the count part of the same statement, so
 * the guard is evaluated against the table as the write sees it.
 *
 * Returns `null` when the cap blocked the insert (zero rows returned).
 */
export async function insertMonitor(
  db: pg.Pool,
  userId: string,
  input: CreateMonitorInput,
  maxPerUser: number,
): Promise<Monitor | null> {
  try {
    const result = await db.query<MonitorRow>(
      `INSERT INTO monitors
              (user_id, name, url, method, expected_status,
               interval_seconds, timeout_ms, headers, active)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9
        WHERE (SELECT count(*) FROM monitors WHERE user_id = $1) < $10
       RETURNING ${RETURNED_COLUMNS}`,
      [
        userId,
        input.name,
        input.url,
        input.method,
        input.expectedStatus,
        input.intervalSeconds,
        input.timeoutMs,
        JSON.stringify(input.headers),
        input.active,
        maxPerUser,
      ],
    );

    const row = result.rows[0];
    return row ? toMonitor(row) : null;
  } catch (error) {
    rethrowConstraintViolation(error);
  }
}

/**
 * List one user's monitors.
 *
 * `id` breaks ties on `created_at`: two rows can share a timestamp, and an
 * unstable order makes the dashboard reshuffle itself between reloads.
 */
export async function listMonitors(
  db: pg.Pool,
  userId: string,
): Promise<Monitor[]> {
  const result = await db.query<MonitorRow>(
    `SELECT ${RETURNED_COLUMNS}
       FROM monitors
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [userId],
  );

  return result.rows.map(toMonitor);
}

/**
 * Fetch one monitor belonging to this user.
 *
 * `user_id` is in the predicate, not compared afterwards in JavaScript. A
 * fetch-then-compare has the row in memory before the decision, so any later
 * early return or log line can leak it — and deleting the comparison breaks
 * nothing visibly. Here, forgetting the scope returns no rows, which the tests
 * catch immediately.
 */
export async function findMonitor(
  db: pg.Pool,
  userId: string,
  monitorId: string,
): Promise<Monitor | null> {
  const result = await db.query<MonitorRow>(
    `SELECT ${RETURNED_COLUMNS}
       FROM monitors
      WHERE id = $1 AND user_id = $2`,
    [monitorId, userId],
  );

  const row = result.rows[0];
  return row ? toMonitor(row) : null;
}

/** Request field -> column, and the only source of column names in an UPDATE. */
const PATCHABLE_COLUMNS = {
  name: 'name',
  url: 'url',
  method: 'method',
  expectedStatus: 'expected_status',
  intervalSeconds: 'interval_seconds',
  timeoutMs: 'timeout_ms',
  headers: 'headers',
  active: 'active',
} as const satisfies Record<keyof PatchMonitorInput, string>;

/**
 * Apply a partial update to a monitor this user owns.
 *
 * Returns `null` when no row matched — which means "not found" and "not yours"
 * indistinguishably, on purpose.
 *
 * The SET list is built from a fixed field-to-column map, never from caller
 * input, so no request key can reach the SQL text. Values stay parameterised.
 */
export async function updateMonitor(
  db: pg.Pool,
  userId: string,
  monitorId: string,
  patch: PatchMonitorInput,
): Promise<Monitor | null> {
  const assignments: string[] = [];
  const values: unknown[] = [monitorId, userId];

  for (const [field, column] of Object.entries(PATCHABLE_COLUMNS)) {
    const value = patch[field as keyof PatchMonitorInput];
    if (value === undefined) continue;

    values.push(field === 'headers' ? JSON.stringify(value) : value);
    const placeholder = `$${String(values.length)}`;
    assignments.push(
      field === 'headers'
        ? `${column} = ${placeholder}::jsonb`
        : `${column} = ${placeholder}`,
    );
  }

  if (assignments.length === 0) {
    // The schema already rejects an empty patch; this keeps the function from
    // emitting a syntactically invalid UPDATE if that ever changes.
    return findMonitor(db, userId, monitorId);
  }

  try {
    const result = await db.query<MonitorRow>(
      `UPDATE monitors
          SET ${assignments.join(', ')},
              -- The column default only fires on INSERT and there is no
              -- trigger, so an UPDATE must set this explicitly or the row
              -- silently keeps a stale timestamp.
              updated_at = now()
        WHERE id = $1 AND user_id = $2
       RETURNING ${RETURNED_COLUMNS}`,
      values,
    );

    const row = result.rows[0];
    return row ? toMonitor(row) : null;
  } catch (error) {
    rethrowConstraintViolation(error);
  }
}

/**
 * Delete a monitor this user owns; `false` when no row matched.
 *
 * `check_results` and `incidents` cascade from this row, so the monitor's
 * entire history goes with it. That is permanent and deliberate — a soft delete
 * would put `AND deleted_at IS NULL` on every future query, and forgetting it
 * once is a data leak.
 */
export async function deleteMonitor(
  db: pg.Pool,
  userId: string,
  monitorId: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM monitors WHERE id = $1 AND user_id = $2`,
    [monitorId, userId],
  );

  return (result.rowCount ?? 0) > 0;
}
