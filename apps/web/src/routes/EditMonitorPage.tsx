import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Page } from '../components/Page.js';
import { ErrorState, Loading } from '../components/states.js';
import { paths } from '../app/paths.js';
import { MonitorForm } from '../features/monitors/MonitorForm.js';
import { monitorErrorMessage } from '../features/monitors/error-messages.js';
import * as monitorsApi from '../features/monitors/monitors-api.js';
import type {
  CreateMonitorInput,
  Monitor,
} from '../features/monitors/types.js';
import { api } from '../lib/api.js';
import { useDocumentTitle } from '../app/useDocumentTitle.js';

/** A settled load of the monitor, tagged with the attempt it answers. */
interface Outcome {
  attempt: number;
  monitor: Monitor | null;
  error: string | null;
}

/**
 * Edit an existing monitor.
 *
 * The monitor is loaded first and the form is only mounted once it arrives, so
 * the fields are never seeded from stale or empty values. A monitor that
 * belongs to someone else is a 404 from the backend, exactly like one that does
 * not exist, and is reported the same way here — the frontend performs no
 * ownership check of its own, because it is not the authority on ownership.
 */
export function EditMonitorPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

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

  // Tagged with the attempt it answers, so a reload is "loading" by derivation
  // rather than by resetting state from inside the effect.
  const settled = outcome?.attempt === attempt ? outcome : null;
  const monitor = settled?.monitor ?? null;
  const loadError = settled?.error ?? null;

  useDocumentTitle(monitor ? `Edit ${monitor.name}` : 'Edit monitor');

  async function handleSubmit(input: CreateMonitorInput) {
    setSubmitError(null);

    try {
      // `method` is omitted: V1 accepts only GET, so sending it back would put
      // an unchangeable field in every patch for nothing. `active` is omitted
      // too — pause and resume belong to the list, and a stale value here
      // would silently resume a monitor someone had just paused.
      await monitorsApi.patchMonitor(api, id, {
        name: input.name,
        url: input.url,
        expectedStatus: input.expectedStatus,
        intervalSeconds: input.intervalSeconds,
        timeoutMs: input.timeoutMs,
        headers: input.headers,
      });
    } catch (error) {
      setSubmitError(monitorErrorMessage(error));
      throw error;
    }

    await navigate(paths.monitors, { replace: true });
  }

  return (
    <Page title="Edit monitor" description={monitor?.name}>
      {loadError ? (
        <ErrorState
          title="Could not load this monitor"
          message={loadError}
          onRetry={() => {
            setAttempt((current) => current + 1);
          }}
        />
      ) : null}

      {!loadError && !monitor ? <Loading label="Loading monitor…" /> : null}

      {monitor ? (
        <MonitorForm
          monitor={monitor}
          submitLabel="Save changes"
          submittingLabel="Saving…"
          submitError={submitError}
          onSubmit={handleSubmit}
          onCancel={() => void navigate(paths.monitors)}
        />
      ) : null}
    </Page>
  );
}
