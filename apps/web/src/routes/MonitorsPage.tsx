import { Link } from 'react-router-dom';

import { Page } from '../components/Page.js';
import { EmptyState, ErrorState, Loading } from '../components/states.js';
import { MonitorRow } from '../features/monitors/MonitorRow.js';
import { useMonitors } from '../features/monitors/useMonitors.js';
import { paths } from '../app/paths.js';
import { useDocumentTitle } from '../app/useDocumentTitle.js';

/**
 * The monitor list.
 *
 * Four intentional states — loading, error, empty, populated — and no fifth
 * accidental one: the hook cannot be "ready with an error", so the page cannot
 * render a half-truth.
 */
export function MonitorsPage() {
  useDocumentTitle('Monitors');

  const { status, monitors, error, reload, replace, remove } = useMonitors();

  return (
    <Page
      title="Monitors"
      description="Endpoints this account is watching."
      actions={
        <Link className="button button--primary" to={paths.monitorNew}>
          Add monitor
        </Link>
      }
    >
      {status === 'loading' ? <Loading label="Loading monitors…" /> : null}

      {status === 'error' ? (
        <ErrorState
          title="Could not load your monitors"
          message={error ?? 'Something went wrong. Please try again.'}
          onRetry={reload}
        />
      ) : null}

      {status === 'ready' && monitors.length === 0 ? (
        <EmptyState
          title="No monitors yet"
          message="Add a public GET endpoint and API Watchdog will check it on a schedule."
          action={
            <Link className="button button--primary" to={paths.monitorNew}>
              Add monitor
            </Link>
          }
        />
      ) : null}

      {status === 'ready' && monitors.length > 0 ? (
        <ul className="monitors">
          {monitors.map((monitor) => (
            <MonitorRow
              key={monitor.id}
              monitor={monitor}
              onReplace={replace}
              onRemove={remove}
            />
          ))}
        </ul>
      ) : null}
    </Page>
  );
}
