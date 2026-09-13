import { Link } from 'react-router-dom';

import { paths } from '../app/paths.js';
import { useDocumentTitle } from '../app/useDocumentTitle.js';
import { Button } from '../components/Button.js';
import { Page } from '../components/Page.js';
import { EmptyState, ErrorState, Loading } from '../components/states.js';
import { useDashboard } from '../features/dashboard/useDashboard.js';
import { MonitorRow } from '../features/monitors/MonitorRow.js';

/**
 * The monitor list.
 *
 * Reads from `GET /api/dashboard`, which is the only endpoint that carries
 * per-monitor health, and carries it for every monitor in one query. The list
 * needs a status, a last-checked time and a response time beside each row;
 * `GET /api/monitors` has none of those, so the alternative would be one extra
 * request per row. The endpoint's name is about the screen it was built for,
 * not a limit on who may read it.
 *
 * Four intentional states — loading, error, empty, populated — and no fifth
 * accidental one: the hook cannot be "ready with an error".
 */
export function MonitorsPage() {
  useDocumentTitle('Monitors');

  const { status, data, error, refreshing, refresh } = useDashboard();

  const monitors = data?.monitors ?? [];

  function renderBody() {
    // The first load shows nothing rather than an empty table, which would
    // read as "you have no monitors" to someone who has twenty.
    if (status === 'loading' && !data) {
      return <Loading label="Loading monitors…" />;
    }

    if (status === 'error' || !data) {
      return (
        <ErrorState
          title="Could not load your monitors"
          message={error ?? 'Something went wrong. Please try again.'}
          onRetry={refresh}
        />
      );
    }

    if (monitors.length === 0) {
      return (
        <EmptyState
          title="No monitors yet"
          message="Add a public GET endpoint and API Watchdog will check it on a schedule."
          action={
            <Link className="button button--primary" to={paths.monitorNew}>
              Add monitor
            </Link>
          }
        />
      );
    }

    return (
      // The wrapper scrolls, not the table: letting the table overflow would
      // push the whole page sideways on a narrow screen.
      <div className="table-scroll">
        <table className="monitors">
          <caption className="visually-hidden">
            Monitors, with the result of each one&rsquo;s latest check
          </caption>
          <thead>
            <tr>
              <th scope="col">Monitor</th>
              <th scope="col">Status</th>
              <th scope="col">Expected</th>
              <th scope="col">Last check</th>
              <th scope="col">Response</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {monitors.map((monitor) => (
              <MonitorRow
                key={monitor.id}
                monitor={monitor}
                onChanged={refresh}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <Page
      title="Monitors"
      description="Endpoints this account is watching."
      actions={
        <div className="page__actions-group">
          <Button
            variant="secondary"
            onClick={refresh}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Link className="button button--primary" to={paths.monitorNew}>
            Add monitor
          </Link>
        </div>
      }
    >
      {renderBody()}
    </Page>
  );
}
