/**
 * A monitor as the API serialises it (`toMonitorResponse` on the backend).
 *
 * Note what is absent: `userId`. The backend omits it deliberately — a caller
 * only ever sees their own monitors — and the frontend never sends it either.
 * Ownership is established from the bearer token, server-side, and nothing
 * here participates in that decision.
 */
export interface Monitor {
  id: string;
  name: string;
  url: string;
  method: string;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutMs: number;
  headers: Record<string, string>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * One stored check, as returned by the manual-check endpoint.
 *
 * `status` describes the *monitored endpoint*, not the API call that produced
 * this object. A 200 from our API carrying `status: 'failure'` is the normal
 * way to learn that a target is down.
 */
export interface CheckResult {
  id: string;
  monitorId: string;
  status: 'success' | 'failure';
  httpStatus: number | null;
  responseTimeMs: number;
  errorType: string | null;
  errorMessage: string | null;
  checkedAt: string;
}

/** The create body. `method` is GET in V1 and the backend accepts nothing else. */
export interface CreateMonitorInput {
  name: string;
  url: string;
  method: 'GET';
  expectedStatus: number;
  intervalSeconds: number;
  timeoutMs: number;
  headers: Record<string, string>;
}

/**
 * The patch body: every field optional, at least one required.
 *
 * The backend uses a strict object, so an unknown key is a 400. That is
 * mass-assignment protection, and it means this type must stay honest about
 * what the API accepts rather than carrying UI-only fields.
 */
export type PatchMonitorInput = Partial<CreateMonitorInput> & {
  active?: boolean;
};
