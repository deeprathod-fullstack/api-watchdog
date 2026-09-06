import type { ApiClient } from '../../lib/api-client.js';
import type { CheckResult, Incident, Page } from './types.js';

/**
 * The two history endpoints, typed.
 *
 * Thin like the other feature API modules: the shared client owns the base
 * URL, the bearer header and error translation. Both endpoints are scoped to a
 * monitor the caller owns — the backend re-establishes ownership with a scoped
 * read and answers 404 for someone else's monitor — so nothing here sends or
 * checks a user id.
 */
export interface PageQuery {
  limit: number;
  offset: number;
  signal?: AbortSignal;
}

export async function listChecks(
  client: ApiClient,
  monitorId: string,
  { limit, offset, signal }: PageQuery,
): Promise<Page<CheckResult>> {
  const page = await client.get<{
    checks: CheckResult[];
    limit: number;
    offset: number;
  }>(`/api/monitors/${monitorId}/checks?limit=${limit}&offset=${offset}`, {
    signal,
  });

  return { items: page.checks, limit: page.limit, offset: page.offset };
}

export async function listIncidents(
  client: ApiClient,
  monitorId: string,
  { limit, offset, signal }: PageQuery,
): Promise<Page<Incident>> {
  const page = await client.get<{
    incidents: Incident[];
    limit: number;
    offset: number;
  }>(`/api/monitors/${monitorId}/incidents?limit=${limit}&offset=${offset}`, {
    signal,
  });

  return { items: page.incidents, limit: page.limit, offset: page.offset };
}
