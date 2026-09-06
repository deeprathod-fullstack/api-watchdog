import {
  HEALTH_LABELS,
  formatCheckedAt,
  formatHttpStatus,
  formatResponseTime,
  healthOf,
} from './health.js';
import type { DashboardMonitor } from './types.js';

/** How many rows the compact list shows. */
const LIMIT = 5;

export interface RecentChecksProps {
  monitors: DashboardMonitor[];
}

/**
 * The most recently checked monitors.
 *
 * Derived from the payload already loaded, not a second request — the
 * dashboard endpoint carries each monitor's *latest* check, so this is that
 * data ordered by time, and it is deliberately labelled as latest-per-monitor
 * rather than as a check log. The full history, with every check rather than
 * the newest one each, belongs to the history endpoint and its own page.
 */
export function RecentChecks({ monitors }: RecentChecksProps) {
  // Paired with a non-null timestamp first, so the comparator needs no
  // assertion about a field the type still says is nullable.
  const recent = monitors
    .flatMap((monitor) =>
      monitor.latestCheckedAt === null
        ? []
        : [{ monitor, checkedAt: monitor.latestCheckedAt }],
    )
    // ISO-8601 UTC strings sort correctly as strings, which is why the backend
    // serialises them that way.
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
    .slice(0, LIMIT);

  if (recent.length === 0) {
    return (
      <p className="section__empty">
        No checks yet. Scheduled checks begin at each monitor&rsquo;s interval,
        or you can run one now from the Monitors page.
      </p>
    );
  }

  return (
    // The wrapper scrolls, not the table: `display: block` on a <table> stops
    // its columns aligning, and letting the table itself overflow pushes the
    // whole page sideways on a narrow screen.
    <div className="table-scroll">
      <table className="activity">
        <caption className="visually-hidden">
          Latest check for each recently checked monitor
        </caption>
        <thead>
          <tr>
            <th scope="col">Monitor</th>
            <th scope="col">Result</th>
            <th scope="col">HTTP</th>
            <th scope="col">Response</th>
            <th scope="col">Checked</th>
          </tr>
        </thead>
        <tbody>
          {recent.map(({ monitor }) => {
            const health = healthOf(monitor);

            return (
              <tr key={monitor.id}>
                <th scope="row">{monitor.name}</th>
                <td>
                  <span className={`badge badge--${health}`}>
                    {HEALTH_LABELS[health]}
                  </span>
                </td>
                <td>{formatHttpStatus(monitor.latestHttpStatus)}</td>
                <td>{formatResponseTime(monitor.latestResponseTimeMs)}</td>
                <td>{formatCheckedAt(monitor.latestCheckedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
