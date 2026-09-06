import type pg from 'pg';

/** One monitor with its latest known state, as PostgreSQL returns it. */
interface DashboardRow {
  id: string;
  name: string;
  url: string;
  active: boolean;
  expected_status: number;
  interval_seconds: number;
  timeout_ms: number;
  latest_status: string | null;
  latest_http_status: number | null;
  latest_response_time_ms: number | null;
  latest_checked_at: Date | null;
  incident_open: boolean;
}

/** One monitor, as the dashboard sees it. */
export interface DashboardMonitor {
  id: string;
  name: string;
  url: string;
  active: boolean;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutMs: number;
  /** `null` when the monitor has never been checked. */
  latestStatus: 'success' | 'failure' | null;
  latestHttpStatus: number | null;
  latestResponseTimeMs: number | null;
  latestCheckedAt: Date | null;
  incidentOpen: boolean;
}

/**
 * Every monitor this user owns, each with its latest check and whether it
 * currently has an open incident — in one statement.
 *
 * The obvious implementation is a list query followed by two more per monitor,
 * which is twenty monitors turned into forty-one round trips. That is the N+1
 * problem, and on a dashboard — the one endpoint loaded on every page view —
 * it is the difference between one query plan and a load that grows with how
 * successful the product is.
 *
 * `LEFT JOIN LATERAL` is what avoids it. A lateral subquery may reference
 * columns from the rows to its left, so `WHERE monitor_id = m.id ... LIMIT 1`
 * is evaluated once per monitor, using the existing
 * `(monitor_id, checked_at DESC)` index to take the newest row directly rather
 * than sorting a monitor's whole history to discard all but one of it. `LEFT`
 * so a monitor with no checks still appears, with nulls — "never checked" is a
 * state the dashboard must show, not a row to drop.
 *
 * The incident join is a plain `LEFT JOIN` and cannot duplicate a monitor,
 * because the partial unique index makes at most one open incident per monitor
 * a storage-level fact rather than an assumption.
 *
 * `user_id` is in the predicate, not compared afterwards in JavaScript, for the
 * same reason as everywhere else: a scope that lives in SQL fails closed when
 * it is forgotten.
 */
export async function loadDashboard(
  db: pg.Pool,
  userId: string,
): Promise<DashboardMonitor[]> {
  const result = await db.query<DashboardRow>(
    `SELECT m.id,
            m.name,
            m.url,
            m.active,
            m.expected_status,
            m.interval_seconds,
            m.timeout_ms,
            latest.status           AS latest_status,
            latest.http_status      AS latest_http_status,
            latest.response_time_ms AS latest_response_time_ms,
            latest.checked_at       AS latest_checked_at,
            (incident.id IS NOT NULL) AS incident_open
       FROM monitors m
       LEFT JOIN LATERAL (
              SELECT status, http_status, response_time_ms, checked_at
                FROM check_results
               WHERE monitor_id = m.id
               ORDER BY checked_at DESC, id DESC
               LIMIT 1
            ) latest ON true
       LEFT JOIN incidents incident
              ON incident.monitor_id = m.id AND incident.status = 'open'
      WHERE m.user_id = $1
      ORDER BY m.created_at DESC, m.id DESC`,
    [userId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    active: row.active,
    expectedStatus: row.expected_status,
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    latestStatus:
      row.latest_status === null
        ? null
        : row.latest_status === 'success'
          ? 'success'
          : 'failure',
    latestHttpStatus: row.latest_http_status,
    latestResponseTimeMs: row.latest_response_time_ms,
    latestCheckedAt: row.latest_checked_at,
    incidentOpen: row.incident_open,
  }));
}
