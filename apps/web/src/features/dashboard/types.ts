/**
 * The dashboard payload, exactly as `GET /api/dashboard` returns it.
 *
 * One request serves the whole page. The backend assembles it with a single
 * lateral-join query precisely so the frontend does not have to fetch each
 * monitor's latest check and incident state separately, so nothing here should
 * grow a second call to fill in.
 */
export interface DashboardSummary {
  total: number;
  /** Monitors that are not paused. Orthogonal to health. */
  active: number;
  /** Latest check succeeded. */
  healthy: number;
  /** Latest check failed. */
  failing: number;
  /** Never checked. */
  unknown: number;
  openIncidents: number;
}

/**
 * One monitor with its latest known state.
 *
 * A narrower shape than the monitors feature's `Monitor` — no headers, no
 * method, no timestamps — because this is what the dashboard query returns.
 * Every `latest*` field is null when the monitor has never been checked, and
 * `latestHttpStatus` and `latestResponseTimeMs` can also be null on a check
 * that never got a response at all.
 */
export interface DashboardMonitor {
  id: string;
  name: string;
  url: string;
  active: boolean;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutMs: number;
  latestStatus: 'success' | 'failure' | null;
  latestHttpStatus: number | null;
  latestResponseTimeMs: number | null;
  latestCheckedAt: string | null;
  incidentOpen: boolean;
}

export interface DashboardData {
  summary: DashboardSummary;
  monitors: DashboardMonitor[];
}
