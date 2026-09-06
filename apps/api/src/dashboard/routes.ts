import { Router, type Request } from 'express';
import type pg from 'pg';

import { type Config } from '@api-watchdog/shared';

import { UnauthenticatedError } from '../errors.js';
import { requireAuth } from '../middleware/require-auth.js';
import { type DashboardMonitor, loadDashboard } from './repository.js';

/**
 * The dashboard's one endpoint.
 *
 * Everything the landing page needs in a single authenticated request, so the
 * frontend does not open with a waterfall of calls and does not have to
 * assemble a coherent picture out of several responses taken at different
 * instants.
 */

/** The counts across the top of the dashboard. */
export interface DashboardSummary {
  total: number;
  active: number;
  /** Latest check succeeded. */
  healthy: number;
  /** Latest check failed. */
  failing: number;
  /** Never checked. */
  unknown: number;
  openIncidents: number;
}

export interface DashboardMonitorResponse {
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

/**
 * Count the monitors by health.
 *
 * Health is the latest check's verdict, and it is deliberately independent of
 * `active`. Pausing a monitor stops us checking it; it does not make the last
 * thing we saw untrue. A paused monitor that was failing when it was paused is
 * still reported as failing, and is still counted in `active` as not active —
 * two orthogonal facts, kept orthogonal, because collapsing them would lose the
 * reason someone paused it in the first place.
 *
 * Computed here rather than in a second aggregate query: the rows are already
 * in hand, and one round trip beats two for a page that is loaded constantly.
 */
function summarise(monitors: DashboardMonitor[]): DashboardSummary {
  const summary: DashboardSummary = {
    total: monitors.length,
    active: 0,
    healthy: 0,
    failing: 0,
    unknown: 0,
    openIncidents: 0,
  };

  for (const monitor of monitors) {
    if (monitor.active) summary.active += 1;
    if (monitor.incidentOpen) summary.openIncidents += 1;

    if (monitor.latestStatus === null) summary.unknown += 1;
    else if (monitor.latestStatus === 'success') summary.healthy += 1;
    else summary.failing += 1;
  }

  return summary;
}

function toResponse(monitor: DashboardMonitor): DashboardMonitorResponse {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    active: monitor.active,
    expectedStatus: monitor.expectedStatus,
    intervalSeconds: monitor.intervalSeconds,
    timeoutMs: monitor.timeoutMs,
    latestStatus: monitor.latestStatus,
    latestHttpStatus: monitor.latestHttpStatus,
    latestResponseTimeMs: monitor.latestResponseTimeMs,
    latestCheckedAt: monitor.latestCheckedAt?.toISOString() ?? null,
    incidentOpen: monitor.incidentOpen,
  };
}

/** The authenticated caller's id; see the note in the monitors router. */
function callerId(req: Request): string {
  if (!req.auth) throw new UnauthenticatedError();

  return req.auth.userId;
}

export function createDashboardRouter(db: pg.Pool, config: Config): Router {
  const router = Router();

  router.use('/api/dashboard', requireAuth(db, config));

  /**
   * No response-time chart and no uptime series here.
   *
   * Those are transformations of the check history, which already has its own
   * endpoint. Computing them server-side would mean choosing a window and a
   * bucket size on the frontend's behalf and then rebuilding the endpoint the
   * first time it wanted different ones.
   */
  router.get('/api/dashboard', async (req, res) => {
    const monitors = await loadDashboard(db, callerId(req));

    res.status(200).json({
      summary: summarise(monitors),
      monitors: monitors.map(toResponse),
    });
  });

  return router;
}
