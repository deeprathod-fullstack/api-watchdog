import { Link } from 'react-router-dom';

import { paths } from '../app/paths.js';
import { Button } from '../components/Button.js';
import { Page } from '../components/Page.js';
import { EmptyState, ErrorState, Loading } from '../components/states.js';
import { MonitorHealthList } from '../features/dashboard/MonitorHealthList.js';
import { OpenIncidents } from '../features/dashboard/OpenIncidents.js';
import { RecentChecks } from '../features/dashboard/RecentChecks.js';
import { SummaryCards } from '../features/dashboard/SummaryCards.js';
import { useDashboard } from '../features/dashboard/useDashboard.js';
import { useDocumentTitle } from '../app/useDocumentTitle.js';

/**
 * The authenticated landing page.
 *
 * One request feeds every section, so the whole page is one of four states —
 * loading, error, empty, populated — and no section can be showing data from a
 * different instant than its neighbour. Ordered by what someone opening this
 * page needs first: overall health, then what is broken, then what happened
 * recently, then everything else.
 */
export function DashboardPage() {
  useDocumentTitle('Dashboard');

  const { status, data, error, refreshing, refresh } = useDashboard();

  // The very first load: no numbers at all rather than a page of zeros, which
  // would read as "you have no monitors" to anyone who does.
  if (status === 'loading' && !data) {
    return (
      <Page title="Dashboard">
        <Loading label="Loading dashboard…" />
      </Page>
    );
  }

  if (status === 'error' || !data) {
    return (
      <Page title="Dashboard">
        <ErrorState
          title="Could not load your dashboard"
          message={error ?? 'Something went wrong. Please try again.'}
          onRetry={refresh}
        />
      </Page>
    );
  }

  if (data.summary.total === 0) {
    return (
      <Page title="Dashboard" description="Health across all of your monitors.">
        <EmptyState
          title="No monitors yet"
          message="Add a public GET endpoint and API Watchdog will check it on a schedule, record every result, and open an incident when it starts failing."
          action={
            <Link className="button button--primary" to={paths.monitorNew}>
              Add monitor
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page
      title="Dashboard"
      description="Health across all of your monitors."
      actions={
        <div className="page__actions-group">
          {/* Disabled while in flight, which is also what stops a second
              click issuing a duplicate request. */}
          <Button
            variant="secondary"
            onClick={refresh}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Link className="button button--secondary" to={paths.monitors}>
            View monitors
          </Link>
          <Link className="button button--primary" to={paths.monitorNew}>
            Add monitor
          </Link>
        </div>
      }
    >
      <SummaryCards summary={data.summary} />

      <section className="section" aria-labelledby="incidents-heading">
        <h2 className="section__title" id="incidents-heading">
          Open incidents
        </h2>
        <OpenIncidents monitors={data.monitors} />
      </section>

      <section className="section" aria-labelledby="activity-heading">
        <h2 className="section__title" id="activity-heading">
          Latest checks
        </h2>
        <RecentChecks monitors={data.monitors} />
      </section>

      <section className="section" aria-labelledby="health-heading">
        <h2 className="section__title" id="health-heading">
          Monitor health
        </h2>
        <MonitorHealthList monitors={data.monitors} />
      </section>
    </Page>
  );
}
