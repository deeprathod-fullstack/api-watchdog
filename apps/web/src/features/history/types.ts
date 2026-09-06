/**
 * One stored check, exactly as `GET /api/monitors/:id/checks` returns it.
 *
 * Note what is absent, and must stay absent: the response body, the request
 * headers, and the monitor's URL. The backend does not store response bodies
 * by default and never puts a header value in a check row, so there is nothing
 * here to leak — and nothing should be added to this type that would change
 * that.
 */
export interface CheckResult {
  id: string;
  monitorId: string;
  status: 'success' | 'failure';
  /** Null when the check never got a response — not zero. */
  httpStatus: number | null;
  responseTimeMs: number | null;
  /** One of the backend's closed set of classifiers. */
  errorType: string | null;
  /** Already bounded and sanitised by the backend; still rendered as text. */
  errorMessage: string | null;
  checkedAt: string;
}

/**
 * One incident, as `GET /api/monitors/:id/incidents` returns it.
 *
 * `status` is explicit, so open-ness is read from it rather than inferred from
 * a missing `resolvedAt`. There is no duration field: the backend does not
 * supply one, and this branch does not compute one.
 */
export interface Incident {
  id: string;
  monitorId: string;
  status: 'open' | 'resolved';
  startedAt: string;
  resolvedAt: string | null;
  failureCount: number;
}

/**
 * A page from either endpoint.
 *
 * `limit` and `offset` are echoed back by the backend so a client can tell a
 * short page from the end of the history without guessing at the default.
 * There is no total count in the contract, so none is displayed.
 */
export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
}
