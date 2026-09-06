import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { paths } from '../app/paths.js';
import { Button } from '../components/Button.js';
import { Page } from '../components/Page.js';
import { EmptyState, ErrorState, Loading } from '../components/states.js';
import { CheckHistoryTable } from '../features/history/CheckHistoryTable.js';
import { IncidentHistoryTable } from '../features/history/IncidentHistoryTable.js';
import { Pager } from '../features/history/Pager.js';
import { listChecks, listIncidents } from '../features/history/history-api.js';
import { usePagedHistory } from '../features/history/usePagedHistory.js';
import { monitorErrorMessage } from '../features/monitors/error-messages.js';
import * as monitorsApi from '../features/monitors/monitors-api.js';
import type { Monitor } from '../features/monitors/types.js';
import { api } from '../lib/api.js';

/** A settled load of the monitor itself, tagged with its attempt. */
interface MonitorOutcome {
  attempt: number;
  monitor: Monitor | null;
  error: string | null;
}

/**
 * Detailed history for one monitor.
 *
 * Three requests, which is the minimum the contract allows: the monitor itself
 * for the header, then one page of checks and one page of incidents. The two
 * history sections load and fail independently, so a broken incidents call
 * cannot make the check table look empty — or vice versa.
 *
 * A monitor belonging to someone else is a 404 from the backend, exactly like
 * one that does not exist, and is reported the same way here. The frontend
 * makes no ownership decision and sends no user id.
 */
export function MonitorHistoryPage() {
  const { id = '' } = useParams<{ id: string }>();

  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<MonitorOutcome | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    monitorsApi
      .getMonitor(api, id, { signal: controller.signal })
      .then((monitor) => {
        setOutcome({ attempt, monitor, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setOutcome({
          attempt,
          monitor: null,
          error: monitorErrorMessage(error),
        });
      });

    return () => {
      controller.abort();
    };
  }, [id, attempt]);

  const checks = usePagedHistory(id, listChecksFor);
  const incidents = usePagedHistory(id, listIncidentsFor);

  const reloadMonitor = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const refreshAll = useCallback(() => {
    checks.refresh();
    incidents.refresh();
  }, [checks, incidents]);

  const settled = outcome?.attempt === attempt ? outcome : null;
  const monitor = settled?.monitor ?? null;
  const monitorError = settled?.error ?? null;
  const refreshing = checks.busy || incidents.busy;

  if (monitorError) {
    return (
      <Page title="Check history">
        <ErrorState
          title="Could not load this monitor"
          message={monitorError}
          onRetry={reloadMonitor}
        />
        <p>
          <Link to={paths.monitors}>Back to monitors</Link>
        </p>
      </Page>
    );
  }

  if (!monitor) {
    return (
      <Page title="Check history">
        <Loading label="Loading monitor…" />
      </Page>
    );
  }

  return (
    <Page
      title={monitor.name}
      description="Every recorded check and incident for this monitor."
      actions={
        <div className="page__actions-group">
          <Button
            variant="secondary"
            onClick={refreshAll}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Link
            className="button button--secondary"
            to={paths.monitorEdit(monitor.id)}
          >
            Edit monitor
          </Link>
          <Link className="button button--secondary" to={paths.monitors}>
            Back to monitors
          </Link>
        </div>
      }
    >
      {/* The monitor's identity, so the history is never read against the
          wrong endpoint. The URL is text, not a link: it is user-supplied and
          points at a third-party host. */}
      <dl className="monitor__facts monitor-summary">
        <div className="monitor__fact">
          <dt>URL</dt>
          <dd>{monitor.url}</dd>
        </div>
        <div className="monitor__fact">
          <dt>State</dt>
          <dd>{monitor.active ? 'Active' : 'Paused'}</dd>
        </div>
        <div className="monitor__fact">
          <dt>Expects</dt>
          <dd>HTTP {monitor.expectedStatus}</dd>
        </div>
        <div className="monitor__fact">
          <dt>Method</dt>
          <dd>{monitor.method}</dd>
        </div>
      </dl>

      <section className="section" aria-labelledby="checks-heading">
        <h2 className="section__title" id="checks-heading">
          Check history
        </h2>

        {checks.status === 'loading' ? (
          <Loading label="Loading check history…" />
        ) : null}

        {checks.status === 'error' ? (
          <ErrorState
            title="Could not load check history"
            message={checks.error ?? 'Something went wrong. Please try again.'}
            onRetry={checks.refresh}
          />
        ) : null}

        {checks.status === 'ready' && checks.items.length === 0 ? (
          <EmptyState
            title="No checks recorded yet"
            message={
              checks.offset > 0
                ? 'There are no more checks beyond this point.'
                : 'Scheduled checks begin at this monitor’s interval, or you can run one now from the Monitors page.'
            }
          />
        ) : null}

        {checks.status === 'ready' && checks.items.length > 0 ? (
          <CheckHistoryTable checks={checks.items} />
        ) : null}

        {checks.status === 'ready' ? (
          <Pager
            label="check history"
            offset={checks.offset}
            pageSize={checks.pageSize}
            count={checks.items.length}
            hasPrevious={checks.hasPrevious}
            hasNext={checks.hasNext}
            busy={checks.busy}
            onPrevious={checks.previous}
            onNext={checks.next}
          />
        ) : null}
      </section>

      <section className="section" aria-labelledby="incidents-heading">
        <h2 className="section__title" id="incidents-heading">
          Incident history
        </h2>

        {incidents.status === 'loading' ? (
          <Loading label="Loading incident history…" />
        ) : null}

        {incidents.status === 'error' ? (
          <ErrorState
            title="Could not load incident history"
            message={
              incidents.error ?? 'Something went wrong. Please try again.'
            }
            onRetry={incidents.refresh}
          />
        ) : null}

        {incidents.status === 'ready' && incidents.items.length === 0 ? (
          <EmptyState
            title="No incidents recorded"
            message={
              incidents.offset > 0
                ? 'There are no more incidents beyond this point.'
                : 'An incident opens after this monitor fails several scheduled checks in a row.'
            }
          />
        ) : null}

        {incidents.status === 'ready' && incidents.items.length > 0 ? (
          <IncidentHistoryTable incidents={incidents.items} />
        ) : null}

        {incidents.status === 'ready' ? (
          <Pager
            label="incident history"
            offset={incidents.offset}
            pageSize={incidents.pageSize}
            count={incidents.items.length}
            hasPrevious={incidents.hasPrevious}
            hasNext={incidents.hasNext}
            busy={incidents.busy}
            onPrevious={incidents.previous}
            onNext={incidents.next}
          />
        ) : null}
      </section>
    </Page>
  );
}

/**
 * Stable module-level bindings.
 *
 * `usePagedHistory` keeps its loader in a dependency list, so passing an inline
 * lambda here would re-run the effect on every render.
 */
function listChecksFor(
  monitorId: string,
  query: Parameters<typeof listChecks>[2],
) {
  return listChecks(api, monitorId, query);
}

function listIncidentsFor(
  monitorId: string,
  query: Parameters<typeof listIncidents>[2],
) {
  return listIncidents(api, monitorId, query);
}
