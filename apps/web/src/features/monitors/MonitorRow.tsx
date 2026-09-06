import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '../../components/Button.js';
import { paths } from '../../app/paths.js';
import { api } from '../../lib/api.js';
import type { ApiClient } from '../../lib/api-client.js';
import { CheckResultSummary } from './CheckResultSummary.js';
import {
  manualCheckErrorMessage,
  monitorErrorMessage,
} from './error-messages.js';
import * as monitorsApi from './monitors-api.js';
import type { CheckResult, Monitor } from './types.js';

/** Which action, if any, is in flight for this monitor. */
type Pending = 'toggle' | 'check' | 'delete' | null;

export interface MonitorRowProps {
  monitor: Monitor;
  onReplace: (monitor: Monitor) => void;
  onRemove: (id: string) => void;
  client?: ApiClient;
}

function describeInterval(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `every ${String(hours)} hour${hours === 1 ? '' : 's'}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `every ${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  }
  return `every ${String(seconds)} seconds`;
}

/**
 * One monitor, with its actions.
 *
 * Each row owns its own pending and error state. That is what lets a check on
 * one monitor run while another is being paused, and keeps a failure attached
 * to the action that caused it instead of blanking the page.
 */
export function MonitorRow({
  monitor,
  onReplace,
  onRemove,
  client = api,
}: MonitorRowProps) {
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const busy = pending !== null;

  // The confirmation replaces the row's actions, so the button that opened it
  // no longer exists and focus would otherwise fall back to the document. Move
  // it onto the confirm button, which is also what makes the new question
  // reach a screen reader.
  useEffect(() => {
    if (confirmingDelete) confirmButtonRef.current?.focus();
  }, [confirmingDelete]);

  /** Cancelling puts focus back where the user left it. */
  function cancelDelete() {
    setConfirmingDelete(false);
    // The Delete button is re-rendered by this state change; focus it once it
    // is back in the DOM.
    requestAnimationFrame(() => deleteButtonRef.current?.focus());
  }

  async function handleToggleActive() {
    if (busy) return;

    setPending('toggle');
    setError(null);

    try {
      // The response is the updated row, so the displayed state comes from the
      // server rather than from an optimistic guess. A failed pause therefore
      // cannot leave the UI claiming something the backend never did.
      onReplace(
        await monitorsApi.patchMonitor(client, monitor.id, {
          active: !monitor.active,
        }),
      );
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
      // Unmounts this row; no state update afterwards.
      onRemove(monitor.id);
    } catch (cause) {
      setError(monitorErrorMessage(cause));
      setPending(null);
      setConfirmingDelete(false);
    }
  }

  return (
    <li className="monitor">
      <div className="monitor__header">
        <div className="monitor__identity">
          <h2 className="monitor__name">{monitor.name}</h2>
          {/* Not a link: this URL is user-supplied and points at a
              third-party host, and the app has no reason to navigate to it. */}
          <p className="monitor__url">{monitor.url}</p>
        </div>

        {/* The same badge vocabulary the dashboard and history use, so
            "Paused" looks and reads identically wherever it appears. */}
        <p className="monitor__state">
          <span
            className={`badge badge--${monitor.active ? 'active' : 'paused'}`}
          >
            {monitor.active ? 'Active' : 'Paused'}
          </span>
        </p>
      </div>

      <dl className="monitor__facts">
        <div className="monitor__fact">
          <dt>Method</dt>
          <dd>{monitor.method}</dd>
        </div>
        <div className="monitor__fact">
          <dt>Expects</dt>
          <dd>HTTP {monitor.expectedStatus}</dd>
        </div>
        <div className="monitor__fact">
          <dt>Schedule</dt>
          <dd>{describeInterval(monitor.intervalSeconds)}</dd>
        </div>
        <div className="monitor__fact">
          <dt>Timeout</dt>
          <dd>{monitor.timeoutMs} ms</dd>
        </div>
      </dl>

      {error ? (
        <p className="form__error" role="alert">
          {error}
        </p>
      ) : null}

      {checkResult ? <CheckResultSummary result={checkResult} /> : null}

      {confirmingDelete ? (
        <div
          className="monitor__confirm"
          role="group"
          aria-label="Confirm delete"
        >
          <p className="monitor__confirm-text">
            Delete <strong>{monitor.name}</strong>? Its check history goes with
            it. This cannot be undone.
          </p>
          <div className="monitor__actions">
            <Button
              ref={confirmButtonRef}
              variant="danger"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {pending === 'delete' ? 'Deleting…' : 'Delete monitor'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={cancelDelete}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="monitor__actions">
          {/* Deliberately enabled while paused: pausing stops the *schedule*,
              and checking a paused monitor by hand is the main reason the
              endpoint exists. */}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void handleManualCheck()}
          >
            {pending === 'check' ? 'Checking…' : 'Check now'}
          </Button>

          <Button
            variant="secondary"
            disabled={busy}
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
            className="button button--secondary"
            to={paths.monitorEdit(monitor.id)}
          >
            Edit
          </Link>

          <Link
            className="button button--secondary"
            to={paths.monitorHistory(monitor.id)}
          >
            History
          </Link>

          <Button
            ref={deleteButtonRef}
            variant="danger"
            disabled={busy}
            onClick={() => {
              setConfirmingDelete(true);
              setError(null);
            }}
          >
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}
