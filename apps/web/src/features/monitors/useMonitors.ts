import { useCallback, useEffect, useState } from 'react';

import { api } from '../../lib/api.js';
import { monitorErrorMessage } from './error-messages.js';
import * as monitorsApi from './monitors-api.js';
import type { Monitor } from './types.js';

type ListStatus = 'loading' | 'ready' | 'error';

/**
 * A settled load, tagged with the request it answers.
 *
 * The tag is what removes the need to reset state when a reload starts: if the
 * stored outcome does not match the current attempt, the hook is loading. That
 * is derived during render rather than assigned from inside the effect, which
 * avoids the extra render pass a synchronous `setStatus('loading')` would cost.
 */
interface Outcome {
  attempt: number;
  monitors: Monitor[] | null;
  error: string | null;
}

export interface MonitorsState {
  status: ListStatus;
  monitors: Monitor[];
  /** Already translated for display; set only when `status === 'error'`. */
  error: string | null;
  reload: () => void;
  /** Swap one monitor in place after a successful mutation. */
  replace: (monitor: Monitor) => void;
  /** Drop one monitor after a successful delete. */
  remove: (id: string) => void;
}

/**
 * Loads the monitor list and keeps it current after mutations.
 *
 * State lives in the component that owns the list, not in a global store: one
 * screen reads it, mutations return the updated monitor, and swapping that
 * object into the array is both simpler and more accurate than invalidating a
 * cache and refetching. No server-state library, and nothing to keep in sync
 * across screens — the create and edit forms navigate back here, which remounts
 * this hook and reloads from the API.
 *
 * The backend caps an account at twenty monitors and returns them unpaginated,
 * so there is no paging to implement and none is invented.
 */
export function useMonitors(client = api): MonitorsState {
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    monitorsApi
      .listMonitors(client, { signal: controller.signal })
      .then((monitors) => {
        setOutcome({ attempt, monitors, error: null });
      })
      .catch((cause: unknown) => {
        // An aborted request is this effect cleaning up after itself, not a
        // failure worth showing anyone.
        if (controller.signal.aborted) return;

        // A 401 has already been reported to the session layer by the API
        // client, which signs the user out and lets the route guard redirect.
        // Recording it here as well keeps this screen honest if it is somehow
        // still mounted.
        setOutcome({
          attempt,
          monitors: null,
          error: monitorErrorMessage(cause),
        });
      });

    return () => {
      controller.abort();
    };
  }, [client, attempt]);

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const replace = useCallback((monitor: Monitor) => {
    setOutcome((current) =>
      current?.monitors
        ? {
            ...current,
            monitors: current.monitors.map((existing) =>
              existing.id === monitor.id ? monitor : existing,
            ),
          }
        : current,
    );
  }, []);

  const remove = useCallback((id: string) => {
    setOutcome((current) =>
      current?.monitors
        ? {
            ...current,
            monitors: current.monitors.filter((monitor) => monitor.id !== id),
          }
        : current,
    );
  }, []);

  const settled = outcome?.attempt === attempt ? outcome : null;

  return {
    status: settled ? (settled.error ? 'error' : 'ready') : 'loading',
    monitors: settled?.monitors ?? [],
    error: settled?.error ?? null,
    reload,
    replace,
    remove,
  };
}
