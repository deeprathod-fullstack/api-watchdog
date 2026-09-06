import { Link } from 'react-router-dom';

import { paths } from '../../app/paths.js';
import {
  HEALTH_LABELS,
  formatCheckedAt,
  formatHttpStatus,
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
 * the only reordering — no filtering, because a monitor missing from the
 * dashboard would read as deleted.
 */
const HEALTH_ORDER = { failing: 0, unchecked: 1, healthy: 2 } as const;

export function MonitorHealthList({ monitors }: MonitorHealthListProps) {
  const ordered = [...monitors].sort(
    (a, b) => HEALTH_ORDER[healthOf(a)] - HEALTH_ORDER[healthOf(b)],
  );

  return (
    <ul className="health">
      {ordered.map((monitor) => {
        const health = healthOf(monitor);

        return (
          <li className={`health__row health__row--${health}`} key={monitor.id}>
            <div className="health__identity">
              <p className="health__name">{monitor.name}</p>
              {/* Not a link: user-supplied and pointing at a third-party host. */}
              <p className="health__url">{monitor.url}</p>
            </div>

            <div className="health__badges">
              {/* Health and paused are two separate facts, shown separately,
                  because pausing a monitor does not make its last result
                  untrue — a monitor can be both paused and failing. */}
              <span className={`badge badge--${health}`}>
                {HEALTH_LABELS[health]}
              </span>
              {monitor.active ? null : (
                <span className="badge badge--paused">Paused</span>
              )}
              {monitor.incidentOpen ? (
                <span className="badge badge--incident">Incident open</span>
              ) : null}
            </div>

            <dl className="health__facts">
              <div className="health__fact">
                <dt>HTTP</dt>
                <dd>{formatHttpStatus(monitor.latestHttpStatus)}</dd>
              </div>
              <div className="health__fact">
                <dt>Response</dt>
                {/* Never fabricated: a check that got no response shows a
                    dash, not 0 ms. */}
                <dd>{formatResponseTime(monitor.latestResponseTimeMs)}</dd>
              </div>
              <div className="health__fact">
                <dt>Expects</dt>
                <dd>HTTP {monitor.expectedStatus}</dd>
              </div>
              <div className="health__fact">
                <dt>Last check</dt>
                <dd>{formatCheckedAt(monitor.latestCheckedAt)}</dd>
              </div>
            </dl>

            <Link className="health__link" to={paths.monitorEdit(monitor.id)}>
              Edit
              <span className="visually-hidden"> {monitor.name}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
