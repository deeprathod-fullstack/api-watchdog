import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Page } from '../components/Page.js';
import { paths } from '../app/paths.js';
import { MonitorForm } from '../features/monitors/MonitorForm.js';
import { monitorErrorMessage } from '../features/monitors/error-messages.js';
import * as monitorsApi from '../features/monitors/monitors-api.js';
import type { CreateMonitorInput } from '../features/monitors/types.js';
import { api } from '../lib/api.js';

export function NewMonitorPage() {
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(input: CreateMonitorInput) {
    setSubmitError(null);

    try {
      await monitorsApi.createMonitor(api, input);
    } catch (error) {
      setSubmitError(monitorErrorMessage(error));
      // Rethrown so the form knows to re-enable itself; it never sees the
      // ApiError, only that the submission failed.
      throw error;
    }

    // Returning to the list remounts `useMonitors`, so the new monitor is read
    // back from the API rather than guessed at locally.
    await navigate(paths.monitors, { replace: true });
  }

  return (
    <Page
      title="New monitor"
      description="Check a public GET endpoint on a schedule."
    >
      <MonitorForm
        submitLabel="Create monitor"
        submittingLabel="Creating…"
        submitError={submitError}
        onSubmit={handleSubmit}
        onCancel={() => void navigate(paths.monitors)}
      />
    </Page>
  );
}
