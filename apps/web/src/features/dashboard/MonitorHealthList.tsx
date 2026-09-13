import { Link } from 'react-router-dom';

import { paths } from '../../app/paths.js';
import {
  HEALTH_LABELS,
  formatAbsolute,
  formatHttpStatus,
  formatRelative,
  formatResponseTime,
  healthOf,
} from './health.js';
import type { DashboardMonitor } from './types.js';

export interface MonitorHealthListProps {
  monitors: DashboardMonitor[];
}

/**
 * Every monitor with its latest known state.
 *
 * Failing monitors are listed first, then never-checked, then healthy: the
 * things needing attention are the reason someone opened this page. Sorting is
 * the only reordering — no filtering and no truncation, because a monitor
 * missing from the dashboard would read as deleted.
 *
 * Read-only. Every action lives one click away on the Monitors page, and the
 * monitor's name links to its history, which is where triage actually goes.
 */
const HEALTH_ORDER = { failing: 0, unchecked: 1, healthy: 2 } as const;

export function MonitorHealthList({ monitors }: MonitorHealthListProps) {
  const ordered = [...monitors].sort(
    (a, b) => HEALTH_ORDER[healthOf(a)] - HEALTH_ORDER[healthOf(b)],
  );

  return (
    <div className="table-scroll">
      <table className="monitors">
        <caption className="visually-hidden">
          Monitors and the result of their latest check, most urgent first
        </caption>
        <thead>
          <tr>
            <th scope="col">Monitor</th>
            <th scope="col">Status</th>
            <th scope="col">HTTP</th>
            <th scope="col">Response</th>
            <th scope="col">Last check</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((monitor) => {
            const health = healthOf(monitor);

            return (
              <tr className="monitor" key={monitor.id}>
                <th scope="row" className="monitor__identity">
                  <Link
                    className="monitor__name"
                    to={paths.monitorHistory(monitor.id)}
                  >
                    {monitor.name}
                  </Link>
                  {/* Not a link: user-supplied, pointing at a third party. */}
                  <span className="monitor__url">{monitor.url}</span>
                </th>

                <td>
                  <span className="monitor__status">
                    <span className={`badge badge--${health}`}>
                      {HEALTH_LABELS[health]}
                    </span>
                    {monitor.active ? null : (
                      <span className="badge badge--paused">Paused</span>
                    )}
                    {monitor.incidentOpen ? (
                      <span className="badge badge--incident">Incident</span>
                    ) : null}
                  </span>
                </td>

                <td className="monitor__numeric">
                  {formatHttpStatus(monitor.latestHttpStatus)}
                </td>

                {/* Never fabricated: a check that got no response shows a
                    dash, not 0 ms. */}
                <td className={`monitor__numeric monitor__response--${health}`}>
                  {formatResponseTime(monitor.latestResponseTimeMs)}
                </td>

                <td className="monitor__numeric">
                  {monitor.latestCheckedAt === null ? (
                    'Never'
                  ) : (
                    <time
                      dateTime={monitor.latestCheckedAt}
                      title={formatAbsolute(monitor.latestCheckedAt)}
                    >
                      {formatRelative(monitor.latestCheckedAt)}
                    </time>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
