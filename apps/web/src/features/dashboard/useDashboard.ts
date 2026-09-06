import { useCallback, useEffect, useState } from 'react';

import { api } from '../../lib/api.js';
import { userErrorMessage } from '../../lib/error-message.js';
import { fetchDashboard } from './dashboard-api.js';
import type { DashboardData } from './types.js';

type DashboardStatus = 'loading' | 'ready' | 'error';

/**
 * A settled load, tagged with the attempt it answers.
 *
 * Same pattern the monitor list uses: the tag makes "loading" a derivation
 * during render rather than a `setState` at the top of the effect, which keeps
 * the hooks lint rule satisfied and saves a render pass.
 */
interface Outcome {
  attempt: number;
  data: DashboardData | null;
  error: string | null;
}

export interface DashboardState {
  status: DashboardStatus;
  data: DashboardData | null;
  /** Already translated for display; set only when `status === 'error'`. */
  error: string | null;
  /** True while a refresh of already-loaded data is in flight. */
  refreshing: boolean;
  refresh: () => void;
}

/**
 * Loads the dashboard.
 *
 * One request, no polling and no timers — the worker does the checking, and
 * this page reads what it found. Refreshing bumps the attempt, which re-runs
 * the effect and replaces the whole payload at once, so no two sections can be
 * showing data from different instants.
 *
 * A refresh keeps the previous data on screen while it runs, so the page does
 * not blank out; `refreshing` is what the button uses to disable itself, which
 * is also what stops a rapid second click issuing a duplicate request.
 */
export function useDashboard(client = api): DashboardState {
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchDashboard(client, { signal: controller.signal })
      .then((data) => {
        setOutcome({ attempt, data, error: null });
      })
      .catch((cause: unknown) => {
        // An aborted request is this effect cleaning up, not a failure.
        if (controller.signal.aborted) return;

        // A 401 has already been reported to the session layer by the API
        // client, which ends the session and lets the route guard redirect.
        setOutcome({ attempt, data: null, error: userErrorMessage(cause) });
      });

    return () => {
      controller.abort();
    };
  }, [client, attempt]);

  const refresh = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const settled = outcome?.attempt === attempt ? outcome : null;
  const previous = outcome?.data ?? null;

  return {
    status: settled ? (settled.error ? 'error' : 'ready') : 'loading',
    // While a refresh is in flight the last good payload stays visible; once
    // an attempt settles, its own result stands alone. A failed refresh
    // therefore clears the page rather than leaving stale numbers under an
    // error banner, where they would read as current.
    data: settled ? settled.data : previous,
    error: settled?.error ?? null,
    refreshing: settled === null && previous !== null,
    refresh,
  };
}
