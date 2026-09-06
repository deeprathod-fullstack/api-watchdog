import { useCallback, useEffect, useState } from 'react';

import { userErrorMessage } from '../../lib/error-message.js';
import type { PageQuery } from './history-api.js';
import type { Page } from './types.js';

/** How many rows a page holds. Well inside the backend's ceiling of 200. */
export const PAGE_SIZE = 25;

type Status = 'loading' | 'ready' | 'error';

/**
 * A settled load, tagged with the attempt it answers — the same pattern the
 * monitor list and dashboard use, so a page change or a refresh is "loading"
 * by derivation rather than by a `setState` at the top of the effect.
 */
interface Outcome<T> {
  attempt: number;
  page: Page<T> | null;
  error: string | null;
}

export interface PagedHistory<T> {
  status: Status;
  items: T[];
  /** Already translated for display; set only when `status === 'error'`. */
  error: string | null;
  offset: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** True while a page change or refresh is in flight. */
  busy: boolean;
  next: () => void;
  previous: () => void;
  refresh: () => void;
}

/**
 * Loads one paginated history endpoint.
 *
 * Shared by the check and incident sections because they are the same endpoint
 * shape with a different row type, and keeping one implementation is what makes
 * their loading, error and paging behaviour identical rather than nearly so.
 * Each section calls it separately, so one endpoint failing cannot make the
 * other look broken.
 *
 * `hasNext` is inferred from a full page rather than read from a total, because
 * the contract does not carry one. That means the last page can look like there
 * is one more, and clicking Next then shows an empty page with Previous
 * available — the honest behaviour for offset pagination without a count, and
 * better than inventing a total the API never gave us.
 */
export function usePagedHistory<T>(
  monitorId: string,
  load: (monitorId: string, query: PageQuery) => Promise<Page<T>>,
): PagedHistory<T> {
  const [attempt, setAttempt] = useState(0);
  const [offset, setOffset] = useState(0);
  const [outcome, setOutcome] = useState<Outcome<T> | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    load(monitorId, {
      limit: PAGE_SIZE,
      offset,
      signal: controller.signal,
    })
      .then((page) => {
        setOutcome({ attempt, page, error: null });
      })
      .catch((cause: unknown) => {
        // An aborted request is this effect cleaning up, not a failure.
        if (controller.signal.aborted) return;

        // A 401 has already been reported to the session layer by the API
        // client, which ends the session and lets the route guard redirect.
        setOutcome({ attempt, page: null, error: userErrorMessage(cause) });
      });

    return () => {
      controller.abort();
    };
    // `load` is in the dependency list, so callers must pass a stable
    // reference — a module-level function, not an inline lambda.
  }, [load, monitorId, offset, attempt]);

  const settled = outcome?.attempt === attempt ? outcome : null;
  const busy = settled === null;

  const refresh = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  // Guarded by `busy` so a rapid second click cannot skip a page or issue a
  // duplicate request; the controls are disabled for the same reason.
  const next = useCallback(() => {
    if (busy) return;
    setOffset((current) => current + PAGE_SIZE);
    setAttempt((current) => current + 1);
  }, [busy]);

  const previous = useCallback(() => {
    if (busy) return;
    setOffset((current) => Math.max(0, current - PAGE_SIZE));
    setAttempt((current) => current + 1);
  }, [busy]);

  const items = settled?.page?.items ?? [];

  return {
    status: settled ? (settled.error ? 'error' : 'ready') : 'loading',
    items,
    error: settled?.error ?? null,
    offset,
    pageSize: PAGE_SIZE,
    hasPrevious: offset > 0,
    hasNext: items.length === PAGE_SIZE,
    busy,
    next,
    previous,
    refresh,
  };
}
