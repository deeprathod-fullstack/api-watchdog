import type pg from 'pg';

import type { Queryable } from '../checks/repository.js';

/** An `incidents` row as PostgreSQL returns it. */
interface IncidentRow {
  id: string;
  monitor_id: string;
  status: string;
  started_at: Date;
  resolved_at: Date | null;
  failure_count: number;
}

/** An incident as the rest of the application sees it. */
export interface Incident {
  id: string;
  monitorId: string;
  status: 'open' | 'resolved';
  startedAt: Date;
  resolvedAt: Date | null;
  failureCount: number;
}

const RETURNED_COLUMNS = `id, monitor_id, status, started_at, resolved_at,
          failure_count`;

export function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status === 'open' ? 'open' : 'resolved',
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    failureCount: row.failure_count,
  };
}

/**
 * The current consecutive-failure streak for one monitor.
 *
 * Derived, never stored. There is no `consecutive_failure_count` column on
 * `monitors`, and deliberately so: a counter is a second copy of something
 * `check_results` already records exactly, and the two would drift the first
 * time a job was delivered twice, a worker died mid-update, or a row was
 * corrected by hand. Recomputing costs one indexed query and cannot be wrong.
 */
export interface FailureStreak {
  /** How many failures in a row, counting from the last success. */
  failures: number;
  /** When the streak began: the `checked_at` of its first failure. */
  firstFailureAt: Date | null;
}

/**
 * Count the failures recorded since this monitor's last success.
 *
 * Everything after the most recent successful check is, by definition, a
 * consecutive failure — so the streak needs no window function and no scan of
 * the whole history, just "rows above this id".
 *
 * `id` is the boundary rather than `checked_at` because it is a strictly
 * increasing sequence with no ties. Two checks can share a timestamp; two rows
 * can never share an id, so there is exactly one answer.
 *
 * A monitor that has never succeeded has no boundary row, and the `COALESCE`
 * to 0 then counts its entire history — which is correct: every check it has
 * ever recorded is part of the current streak.
 */
export async function currentFailureStreak(
  db: Queryable,
  monitorId: string,
): Promise<FailureStreak> {
  const result = await db.query<{
    failures: string;
    first_failure_at: Date | null;
  }>(
    `SELECT count(*)::text AS failures,
            min(checked_at)  AS first_failure_at
       FROM check_results
      WHERE monitor_id = $1
        AND id > COALESCE(
              (SELECT max(id) FROM check_results
                WHERE monitor_id = $1 AND status = 'success'), 0)`,
    [monitorId],
  );

  const row = result.rows[0];

  return {
    failures: row === undefined ? 0 : Number(row.failures),
    firstFailureAt: row?.first_failure_at ?? null,
  };
}

/**
 * Open an incident, unless this monitor already has one open.
 *
 * `ON CONFLICT` against the partial unique index rather than a preceding
 * `SELECT`. Read-then-write is a time-of-check-to-time-of-use race: two workers
 * crossing the threshold at the same moment, or one job delivered twice, both
 * read "no open incident" and both insert. Here the second transaction blocks
 * on the index until the first commits and then does nothing, so the
 * one-open-incident invariant is enforced by storage and not by hope.
 *
 * Returns `null` when an incident was already open.
 */
export async function openIncident(
  db: Queryable,
  monitorId: string,
  startedAt: Date,
  failureCount: number,
): Promise<Incident | null> {
  const result = await db.query<IncidentRow>(
    `INSERT INTO incidents (monitor_id, status, started_at, failure_count)
          VALUES ($1, 'open', $2, $3)
     ON CONFLICT (monitor_id) WHERE status = 'open' DO NOTHING
       RETURNING ${RETURNED_COLUMNS}`,
    [monitorId, startedAt, failureCount],
  );

  const row = result.rows[0];
  return row ? toIncident(row) : null;
}

/**
 * Update the failure count of this monitor's open incident.
 *
 * The count is *set* to the streak rather than incremented. An increment
 * assumes it has seen every failure exactly once; setting a derived value is
 * correct however many times it runs, which is what makes a redelivered job
 * harmless.
 */
export async function growIncident(
  db: Queryable,
  monitorId: string,
  failureCount: number,
): Promise<Incident | null> {
  const result = await db.query<IncidentRow>(
    `UPDATE incidents
        SET failure_count = $2
      WHERE monitor_id = $1 AND status = 'open'
     RETURNING ${RETURNED_COLUMNS}`,
    [monitorId, failureCount],
  );

  const row = result.rows[0];
  return row ? toIncident(row) : null;
}

/**
 * Close this monitor's open incident, if it has one.
 *
 * Scoped to `status = 'open'`, so a resolved incident is never touched again:
 * resolution is terminal, and a later failure streak opens a new incident
 * rather than reviving an old one. Returns `null` when nothing was open, which
 * is the ordinary case for a healthy monitor.
 */
export async function resolveIncident(
  db: Queryable,
  monitorId: string,
  resolvedAt: Date,
): Promise<Incident | null> {
  const result = await db.query<IncidentRow>(
    `UPDATE incidents
        SET status = 'resolved', resolved_at = $2
      WHERE monitor_id = $1 AND status = 'open'
     RETURNING ${RETURNED_COLUMNS}`,
    [monitorId, resolvedAt],
  );

  const row = result.rows[0];
  return row ? toIncident(row) : null;
}

/**
 * One page of a monitor's incident history, newest first.
 *
 * Owner-scoped in the `WHERE` clause via the monitor's `user_id`, for the same
 * reason the monitor queries are: a scope that lives in SQL fails closed if it
 * is forgotten, whereas a scope compared in JavaScript after the fetch has
 * already put the rows in memory.
 *
 * `id` breaks ties on `started_at` so the order is total and a page boundary
 * cannot show the same row twice.
 */
export async function listIncidents(
  db: pg.Pool,
  userId: string,
  monitorId: string,
  limit: number,
  offset: number,
): Promise<Incident[]> {
  const result = await db.query<IncidentRow>(
    `SELECT ${RETURNED_COLUMNS}
       FROM incidents
      WHERE monitor_id = $1
        AND monitor_id IN (SELECT id FROM monitors WHERE user_id = $2)
      ORDER BY started_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [monitorId, userId, limit, offset],
  );

  return result.rows.map(toIncident);
}
