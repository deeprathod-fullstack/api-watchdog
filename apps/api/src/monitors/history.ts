import { z } from 'zod';

import type { Incident } from '../incidents/repository.js';

/**
 * Pagination and serialisation for the two history endpoints.
 *
 * Both answer the same question in a different table — "what has happened to
 * this monitor, newest first" — so they share one page schema rather than
 * growing two that drift apart.
 */

/** The default page. Enough to fill a dashboard panel without a second call. */
const DEFAULT_LIMIT = 50;

/**
 * The largest page anyone may ask for.
 *
 * A limit is not a nicety. Without one, `?limit=1000000` is a request that
 * makes the database materialise an unbounded result set and the API serialise
 * it — one cheap call turning into arbitrary work, which is the shape of every
 * accidental denial of service. The ceiling is what makes the cost of a request
 * knowable in advance.
 */
const MAX_LIMIT = 200;

/**
 * `z.coerce`, unlike the request bodies.
 *
 * A query string has no types: every value arrives as a string, so coercion is
 * describing reality here rather than papering over it. The bounds still do the
 * real work — a non-numeric or out-of-range value is a 400, not a silent
 * fallback to the default, because quietly ignoring a parameter hides the
 * client bug that sent it.
 */
export const pageQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1, 'must be at least 1')
    .max(MAX_LIMIT, `must be at most ${String(MAX_LIMIT)}`)
    .default(DEFAULT_LIMIT),
  offset: z.coerce
    .number()
    .int()
    .min(0, 'must not be negative')
    // Bounded too: a huge offset makes PostgreSQL walk and discard every row
    // before it, so an unbounded one is the same unbounded work by another
    // name.
    .max(10_000, 'must be at most 10000')
    .default(0),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/** The API representation of a stored incident. */
export interface IncidentResponse {
  id: string;
  monitorId: string;
  status: 'open' | 'resolved';
  startedAt: string;
  resolvedAt: string | null;
  failureCount: number;
}

export function toIncidentResponse(incident: Incident): IncidentResponse {
  return {
    id: incident.id,
    monitorId: incident.monitorId,
    status: incident.status,
    startedAt: incident.startedAt.toISOString(),
    // Null rather than omitted: "still open" is a fact the frontend branches
    // on, and an absent key is easier to misread as an oversight.
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    failureCount: incident.failureCount,
  };
}
