import { ApiError } from '../../lib/api-error.js';
import type { ApiClient } from '../../lib/api-client.js';
import type { DashboardData, DashboardMonitor } from './types.js';

/**
 * The dashboard's single request.
 *
 * Deliberately the only function in this module: the endpoint returns the
 * whole page in one response, and adding a second call here would reintroduce
 * exactly the waterfall the backend built its lateral-join query to avoid.
 */
export async function fetchDashboard(
  client: ApiClient,
  options?: { signal?: AbortSignal },
): Promise<DashboardData> {
  return asDashboardData(await client.get<unknown>('/api/dashboard', options));
}

/**
 * Check the payload's shape before anything renders it.
 *
 * A response is a value from outside the program, and `as DashboardData` is a
 * claim rather than a check: a proxy error page or a contract change would sail
 * through the type system and surface as "cannot read properties of undefined"
 * halfway down the component tree, where it reads as a frontend bug. Failing
 * here turns that into the error state the page already knows how to show.
 *
 * Only the fields the dashboard actually uses are checked, and unknown extra
 * fields are ignored — a backend that adds one must not break this page.
 */
function asDashboardData(payload: unknown): DashboardData {
  const body = asRecord(payload);
  const summary = body && asRecord(body.summary);

  if (
    !body ||
    !summary ||
    !Array.isArray(body.monitors) ||
    !isInteger(summary.total) ||
    !isInteger(summary.active) ||
    !isInteger(summary.healthy) ||
    !isInteger(summary.failing) ||
    !isInteger(summary.unknown) ||
    !isInteger(summary.openIncidents)
  ) {
    throw malformed();
  }

  return {
    summary: {
      total: summary.total,
      active: summary.active,
      healthy: summary.healthy,
      failing: summary.failing,
      unknown: summary.unknown,
      openIncidents: summary.openIncidents,
    },
    monitors: body.monitors.map(asDashboardMonitor),
  };
}

function asDashboardMonitor(value: unknown): DashboardMonitor {
  const monitor = asRecord(value);

  if (
    !monitor ||
    typeof monitor.id !== 'string' ||
    typeof monitor.name !== 'string' ||
    typeof monitor.url !== 'string' ||
    typeof monitor.active !== 'boolean' ||
    typeof monitor.incidentOpen !== 'boolean' ||
    !isInteger(monitor.expectedStatus) ||
    !isInteger(monitor.intervalSeconds) ||
    !isInteger(monitor.timeoutMs) ||
    !isLatestStatus(monitor.latestStatus) ||
    !isNullableInteger(monitor.latestHttpStatus) ||
    !isNullableInteger(monitor.latestResponseTimeMs) ||
    !isNullableString(monitor.latestCheckedAt)
  ) {
    throw malformed();
  }

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
    latestCheckedAt: monitor.latestCheckedAt,
    incidentOpen: monitor.incidentOpen,
  };
}

/**
 * Reported as an `ApiError` so the page's existing error handling covers it,
 * with a message that says nothing about the payload — an unexpected body is
 * exactly the kind of thing that should not be echoed onto a screen.
 */
function malformed(): ApiError {
  return new ApiError(
    200,
    'invalid_response',
    'Something went wrong. Please try again.',
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || isInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isLatestStatus(value: unknown): value is 'success' | 'failure' | null {
  return value === null || value === 'success' || value === 'failure';
}
