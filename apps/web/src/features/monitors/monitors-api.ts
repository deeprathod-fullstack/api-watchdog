import type { ApiClient } from '../../lib/api-client.js';
import type {
  CheckResult,
  CreateMonitorInput,
  Monitor,
  PatchMonitorInput,
} from './types.js';

/**
 * The monitor endpoints, typed.
 *
 * Thin by design, exactly like `auth-api.ts`: each function maps one call onto
 * the API contract and does nothing else. The client supplies the base URL, the
 * bearer header and the error translation, so none of that is repeated here and
 * none of it can drift between screens.
 *
 * Responses are enveloped (`{ monitors }`, `{ monitor }`, `{ check }`) because
 * the backend envelopes them; these functions unwrap so callers work with the
 * domain object.
 */
export async function listMonitors(
  client: ApiClient,
  options?: { signal?: AbortSignal },
): Promise<Monitor[]> {
  const { monitors } = await client.get<{ monitors: Monitor[] }>(
    '/api/monitors',
    options,
  );

  return monitors;
}

export async function getMonitor(
  client: ApiClient,
  id: string,
  options?: { signal?: AbortSignal },
): Promise<Monitor> {
  const { monitor } = await client.get<{ monitor: Monitor }>(
    `/api/monitors/${id}`,
    options,
  );

  return monitor;
}

export async function createMonitor(
  client: ApiClient,
  input: CreateMonitorInput,
): Promise<Monitor> {
  const { monitor } = await client.post<{ monitor: Monitor }>(
    '/api/monitors',
    input,
  );

  return monitor;
}

export async function patchMonitor(
  client: ApiClient,
  id: string,
  patch: PatchMonitorInput,
): Promise<Monitor> {
  const { monitor } = await client.patch<{ monitor: Monitor }>(
    `/api/monitors/${id}`,
    patch,
  );

  return monitor;
}

/** Returns 204 with no body, so there is nothing to unwrap. */
export function deleteMonitor(client: ApiClient, id: string): Promise<void> {
  return client.delete<void>(`/api/monitors/${id}`);
}

/**
 * Run one check now.
 *
 * Resolves whenever the check *ran*, whatever it found. A monitored endpoint
 * that timed out or answered the wrong status produces a 200 here with a
 * `failure` result — it is a successful call reporting bad news, and callers
 * must not present it as a failed request.
 */
export async function runManualCheck(
  client: ApiClient,
  id: string,
): Promise<CheckResult> {
  const { check } = await client.post<{ check: CheckResult }>(
    `/api/monitors/${id}/check`,
  );

  return check;
}
