import type pg from 'pg';

import type { ClassifiedCheck } from './classify.js';

/** A `check_results` row as the API represents it. */
export interface CheckResult {
  /**
   * `bigint` in the database, so it arrives as a string.
   *
   * Kept as a string all the way out: an identity value beyond 2^53 loses
   * precision as a JavaScript number, and inventing that bug for a future
   * dashboard would be careless.
   */
  id: string;
  monitorId: string;
  status: 'success' | 'failure';
  httpStatus: number | null;
  responseTimeMs: number;
  errorType: string | null;
  errorMessage: string | null;
  checkedAt: Date;
}

interface CheckResultRow {
  id: string;
  monitor_id: string;
  status: string;
  http_status: number | null;
  response_time_ms: number;
  error_type: string | null;
  error_message: string | null;
  checked_at: Date;
}

/**
 * Anything that can run a statement: the pool, or one client inside a
 * transaction.
 *
 * A manual check writes one row and needs no transaction. A scheduled check
 * writes that row *and* moves an incident, and those two must land together or
 * not at all. Both paths run the same insert, so it accepts either.
 */
export type Queryable = Pick<pg.Pool, 'query'>;

/** The monitor disappeared between authorisation and the write. */
export class MonitorGoneError extends Error {
  override readonly name = 'MonitorGoneError';
}

/** SQLSTATE for a foreign-key violation. */
const FOREIGN_KEY_VIOLATION = '23503';

function toCheckResult(row: CheckResultRow): CheckResult {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status === 'success' ? 'success' : 'failure',
    httpStatus: row.http_status,
    responseTimeMs: row.response_time_ms,
    errorType: row.error_type,
    errorMessage: row.error_message,
    checkedAt: row.checked_at,
  };
}

/**
 * Record one check.
 *
 * `checked_at` is left to the column default so the database owns the
 * timestamp — which also means that inside a transaction every statement sees
 * the same `now()`, and a check and the incident it triggers share one instant
 * rather than two that could be ordered wrongly.
 *
 * No response body is written; there is no column for one, and nothing
 * upstream holds one.
 */
export async function insertCheckResult(
  db: Queryable,
  monitorId: string,
  check: ClassifiedCheck,
): Promise<CheckResult> {
  try {
    const result = await db.query<CheckResultRow>(
      `INSERT INTO check_results
              (monitor_id, status, http_status, response_time_ms,
               error_type, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, monitor_id, status, http_status, response_time_ms,
                 error_type, error_message, checked_at`,
      [
        monitorId,
        check.status,
        check.httpStatus,
        check.responseTimeMs,
        check.errorType,
        check.errorMessage,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error('INSERT ... RETURNING produced no row');

    return toCheckResult(row);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === FOREIGN_KEY_VIOLATION
    ) {
      // The monitor was deleted while its check was running. Recording a
      // result for a monitor that no longer exists would be worse than
      // reporting it as gone.
      throw new MonitorGoneError('Monitor no longer exists');
    }
    throw error;
  }
}

/**
 * One page of a monitor's check history, newest first.
 *
 * `id` breaks the tie on `checked_at`, and it is the better tiebreaker for the
 * same reason it is the better streak boundary: two checks can share a
 * timestamp, two rows cannot share an id. Without a total order a row could
 * appear on two pages, or on none.
 *
 * Offset paging rather than a cursor. The per-user monitor cap and the bounded
 * limit keep the offsets a dashboard actually asks for small, and a cursor
 * scheme is real complexity — opaque tokens, tie-breaking encoded into them,
 * a migration when the sort changes — bought for a scale V1 does not have.
 */
export async function listCheckResults(
  db: pg.Pool,
  monitorId: string,
  limit: number,
  offset: number,
): Promise<CheckResult[]> {
  const result = await db.query<CheckResultRow>(
    `SELECT id, monitor_id, status, http_status, response_time_ms,
            error_type, error_message, checked_at
       FROM check_results
      WHERE monitor_id = $1
      ORDER BY checked_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [monitorId, limit, offset],
  );

  return result.rows.map(toCheckResult);
}
