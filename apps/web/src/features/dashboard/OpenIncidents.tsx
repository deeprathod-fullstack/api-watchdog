import { Link } from 'react-router-dom';

import { paths } from '../../app/paths.js';
import { EmptyState } from '../../components/states.js';
import {
  formatCheckedAt,
  formatHttpStatus,
  formatResponseTime,
} from './health.js';
import type { DashboardMonitor } from './types.js';

export interface OpenIncidentsProps {
  monitors: DashboardMonitor[];
}

/**
 * The monitors currently carrying an open incident.
 *
 * Display only. Incidents are opened and resolved by the backend's incident
 * engine when consecutive checks fail or a monitor recovers; there is no
 * frontend rule here and no manual resolve control, because the API offers
 * none and inventing one would let the UI claim something it cannot do.
 *
 * What is shown is what the dashboard endpoint carries: the monitor and its
 * latest failing check. The incident's own start time and failure count live
 * behind the per-monitor incident endpoint, and fetching that for each monitor
 * would be the N+1 the dashboard query exists to avoid.
 */
export function OpenIncidents({ monitors }: OpenIncidentsProps) {
  const affected = monitors.filter((monitor) => monitor.incidentOpen);

  if (affected.length === 0) {
    return (
      <EmptyState
        title="No open incidents"
        message="Every monitor with a recorded check is either passing or has not failed often enough to open one."
        headingLevel={3}
      />
    );
  }

  return (
    <ul className="incidents">
      {affected.map((monitor) => (
        <li className="incident" key={monitor.id}>
          <div className="incident__header">
            <p className="incident__name">{monitor.name}</p>
            <span className="badge badge--incident">Open</span>
          </div>
          <p className="incident__url">{monitor.url}</p>
          <dl className="health__facts">
            <div className="health__fact">
              <dt>Latest check</dt>
              <dd>{formatCheckedAt(monitor.latestCheckedAt)}</dd>
            </div>
            <div className="health__fact">
              <dt>HTTP</dt>
              <dd>{formatHttpStatus(monitor.latestHttpStatus)}</dd>
            </div>
            <div className="health__fact">
              <dt>Expected</dt>
              <dd>HTTP {monitor.expectedStatus}</dd>
            </div>
            <div className="health__fact">
              <dt>Response</dt>
              <dd>{formatResponseTime(monitor.latestResponseTimeMs)}</dd>
            </div>
          </dl>
          <p className="health__links">
            <Link
              className="health__link"
              to={paths.monitorHistory(monitor.id)}
              aria-label={`History for ${monitor.name}`}
            >
              History
            </Link>
            <Link
              className="health__link"
              to={paths.monitorEdit(monitor.id)}
              aria-label={`Edit ${monitor.name}`}
            >
              Edit
            </Link>
          </p>
        </li>
      ))}
    </ul>
  );
}
