import type { DashboardMonitor } from './types.js';

/**
 * How a monitor's latest check reads on screen.
 *
 * These are a direct rendering of `latestStatus`, not a frontend health rule.
 * The backend decides what "healthy" means — it is the verdict of the most
 * recent stored check — and this only picks the word for each of the three
 * values that field can take. In particular `null` is its own state: a monitor
 * that has never been checked is *not* healthy, and showing it as healthy would
 * be the single most misleading thing this page could do.
 */
export type HealthState = 'healthy' | 'failing' | 'unchecked';

export function healthOf(monitor: DashboardMonitor): HealthState {
  if (monitor.latestStatus === null) return 'unchecked';

  return monitor.latestStatus === 'success' ? 'healthy' : 'failing';
}

export const HEALTH_LABELS: Record<HealthState, string> = {
  healthy: 'Healthy',
  failing: 'Failing',
  unchecked: 'No check yet',
};

/**
 * Paused monitors, counted rather than read from the payload.
 *
 * The summary reports `active`, not `paused`, and `total - active` is the only
 * thing it can mean. This is arithmetic on the backend's own numbers, not a
 * metric invented here.
 *
 * Health and paused stay separate on purpose, exactly as the backend keeps
 * them: pausing stops us checking a monitor, it does not make the last thing we
 * saw untrue. A monitor that was failing when it was paused is still failing.
 */
export function pausedCount(summary: {
  total: number;
  active: number;
}): number {
  return summary.total - summary.active;
}

/** `null` means "no response was recorded", which is not the same as 0 ms. */
export function formatResponseTime(ms: number | null): string {
  return ms === null ? '—' : `${String(ms)} ms`;
}

export function formatHttpStatus(status: number | null): string {
  return status === null ? '—' : String(status);
}

/**
 * A check time, as an absolute local time with a relative hint.
 *
 * Relative alone ("2 minutes ago") goes stale on a page nobody reloads, and
 * absolute alone makes the reader do arithmetic. Both is short enough here.
 */
export function formatCheckedAt(iso: string | null, now = Date.now()): string {
  if (iso === null) return 'Never checked';

  const checkedAt = new Date(iso);
  if (Number.isNaN(checkedAt.getTime())) return 'Unknown';

  return `${checkedAt.toLocaleString()} (${describeAge(now - checkedAt.getTime())})`;
}

function describeAge(elapsedMs: number): string {
  if (elapsedMs < 0) return 'just now';

  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;

  const days = Math.floor(hours / 24);
  return `${String(days)} d ago`;
}
