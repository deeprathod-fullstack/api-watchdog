import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { paths } from '../../app/paths.js';
import { Button } from '../../components/Button.js';
import {
  HEALTH_LABELS,
  formatAbsolute,
  formatRelative,
  formatResponseTime,
  healthOf,
} from '../dashboard/health.js';
import type { DashboardMonitor } from '../dashboard/types.js';
import { api } from '../../lib/api.js';
import type { ApiClient } from '../../lib/api-client.js';
import { CheckResultSummary } from './CheckResultSummary.js';
import {
  manualCheckErrorMessage,
  monitorErrorMessage,
} from './error-messages.js';
import * as monitorsApi from './monitors-api.js';
import type { CheckResult } from './types.js';

/** Which action, if any, is in flight for this monitor. */
type Pending = 'toggle' | 'check' | 'delete' | null;

export interface MonitorRowProps {
  /**
   * The dashboard's view of a monitor: identity plus its latest check.
   *
   * The monitor list reads from `GET /api/dashboard` because that is the one
   * endpoint carrying per-monitor health, and it carries it for every monitor
   * in a single query. `GET /api/monitors` has no check data at all, so the
   * alternative would be one extra request per row.
   */
  monitor: DashboardMonitor;
  /** Re-reads the list after a mutation, so counts and health stay truthful. */
  onChanged: () => void;
  client?: ApiClient;
}

/** The number of columns a detail row has to span to sit under the table. */
const COLUMN_COUNT = 6;

/**
 * One monitor, as a table row.
 *
 * Each row owns its own pending and error state. That is what lets a check on
 * one monitor run while another is being paused, and keeps a failure attached
 * to the action that caused it instead of blanking the page.
 *
 * A manual check result, a delete confirmation and an error each render as a
 * second row spanning the table rather than as something squeezed into a cell —
 * which keeps the table a table, with its columns still aligned.
 */
export function MonitorRow({
  monitor,
  onChanged,
  client = api,
}: MonitorRowProps) {
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const busy = pending !== null;
  const health = healthOf(monitor);

  // The confirmation replaces the row's actions, so the button that opened it
  // no longer exists and focus would otherwise fall back to the document.
  useEffect(() => {
    if (confirmingDelete) confirmButtonRef.current?.focus();
  }, [confirmingDelete]);

  function cancelDelete() {
    setConfirmingDelete(false);
    requestAnimationFrame(() => deleteButtonRef.current?.focus());
  }

  async function handleToggleActive() {
    if (busy) return;

    setPending('toggle');
    setError(null);

    try {
      await monitorsApi.patchMonitor(client, monitor.id, {
        active: !monitor.active,
      });
      // Re-read rather than patch the row in place: pausing changes the
      // summary counts too, and a stale "12 active" beside a paused monitor is
      // worse than one extra request.
      onChanged();
    } catch (cause) {
      setError(monitorErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  async function handleManualCheck() {
    if (busy) return;

    setPending('check');
    setError(null);
    setCheckResult(null);

    try {
      // A resolved promise means the check *ran*. Whether the monitored
      // endpoint was healthy is in the result, and is not this call's failure.
      setCheckResult(await monitorsApi.runManualCheck(client, monitor.id));
      onChanged();
    } catch (cause) {
      setError(manualCheckErrorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  async function handleDelete() {
    if (busy) return;

    setPending('delete');
    setError(null);

    try {
      await monitorsApi.deleteMonitor(client, monitor.id);
      onChanged();
    } catch (cause) {
      setError(monitorErrorMessage(cause));
      setPending(null);
      setConfirmingDelete(false);
    }
  }

  return (
    <>
      <tr className="monitor">
        <th scope="row" className="monitor__identity">
          <span className="monitor__name">{monitor.name}</span>
          {/* Not a link: user-supplied and pointing at a third-party host. */}
          <span className="monitor__url">{monitor.url}</span>
        </th>

        <td>
          <span className="monitor__status">
            <span className={`badge badge--${health}`}>
              {HEALTH_LABELS[health]}
            </span>
            {/* Health and paused are two separate facts: pausing stops the
                schedule, it does not make the last result untrue. */}
            {monitor.active ? null : (
              <span className="badge badge--paused">Paused</span>
            )}
            {monitor.incidentOpen ? (
              <span className="badge badge--incident">Incident</span>
            ) : null}
          </span>
        </td>

        <td className="monitor__numeric">{monitor.expectedStatus}</td>

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

        {/* A check that never got a response has no timing. It is a dash,
            never "0 ms". */}
        <td className={`monitor__numeric monitor__response--${health}`}>
          {formatResponseTime(monitor.latestResponseTimeMs)}
        </td>

        <td className="monitor__actions-cell">
          {confirmingDelete ? null : (
            <div className="monitor__actions">
              {/* Deliberately enabled while paused: pausing stops the
                  schedule, and checking a paused monitor by hand is the main
                  reason the endpoint exists. */}
              <Button
                variant="subtle"
                disabled={busy}
                aria-busy={pending === 'check'}
                aria-label={`Check ${monitor.name} now`}
                onClick={() => void handleManualCheck()}
              >
                {pending === 'check' ? 'Checking…' : 'Check'}
              </Button>

              <Button
                variant="subtle"
                disabled={busy}
                aria-busy={pending === 'toggle'}
                aria-label={`${monitor.active ? 'Pause' : 'Resume'} ${monitor.name}`}
                onClick={() => void handleToggleActive()}
              >
                {pending === 'toggle'
                  ? monitor.active
                    ? 'Pausing…'
                    : 'Resuming…'
                  : monitor.active
                    ? 'Pause'
                    : 'Resume'}
              </Button>

              <Link
                className="button button--subtle"
                to={paths.monitorEdit(monitor.id)}
                aria-label={`Edit ${monitor.name}`}
              >
                Edit
              </Link>

              <Link
                className="button button--subtle"
                to={paths.monitorHistory(monitor.id)}
                aria-label={`History for ${monitor.name}`}
              >
                History
              </Link>

              <Button
                ref={deleteButtonRef}
                variant="subtle-danger"
                disabled={busy}
                aria-label={`Delete ${monitor.name}`}
                onClick={() => {
                  setConfirmingDelete(true);
                  setError(null);
                }}
              >
                Delete
              </Button>
            </div>
          )}
        </td>
      </tr>

      {confirmingDelete ? (
        <tr className="monitor__detail">
          <td colSpan={COLUMN_COUNT}>
            <div
              className="monitor__confirm"
              role="group"
              aria-label={`Confirm deleting ${monitor.name}`}
            >
              <p className="monitor__confirm-text">
                Delete <strong>{monitor.name}</strong>? Its check history goes
                with it. This cannot be undone.
              </p>
              <div className="monitor__confirm-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={cancelDelete}
                >
                  Cancel
                </Button>
                <Button
                  ref={confirmButtonRef}
                  variant="danger"
                  disabled={busy}
                  onClick={() => void handleDelete()}
                >
                  {pending === 'delete' ? 'Deleting…' : 'Delete monitor'}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}

      {error ? (
        <tr className="monitor__detail">
          <td colSpan={COLUMN_COUNT}>
            <p className="form__error" role="alert">
              {error}
            </p>
          </td>
        </tr>
      ) : null}

      {checkResult ? (
        <tr className="monitor__detail">
          <td colSpan={COLUMN_COUNT}>
            <CheckResultSummary result={checkResult} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
