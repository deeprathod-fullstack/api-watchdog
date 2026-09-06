import { z } from 'zod';

import { guardUrl, type UrlRejection } from '../checks/url-guard.js';

/**
 * Header names we refuse to store, whatever the value.
 *
 * Monitor headers are stored in plaintext in a table that will be dumped,
 * backed up and read by support queries. A credential in there is a leak with
 * no expiry and no rotation story, so the boundary rejects the header outright
 * rather than trying to protect it afterwards.
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
]);

/** RFC 7230 token characters: the only thing a header name may contain. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * Printable ASCII only.
 *
 * The point is excluding CR and LF: a newline inside a header value splits it
 * into additional headers when we build the outbound request (response
 * splitting / header injection), letting a caller forge headers we never
 * intended to send.
 */
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]*$/;

const MAX_HEADERS = 10;
const MAX_HEADER_NAME_LENGTH = 100;
const MAX_HEADER_VALUE_LENGTH = 1024;

/**
 * Non-secret request headers.
 *
 * Errors name the offending header *name* and never its value — an error
 * message is the one place a rejected secret would otherwise get written down.
 */
const headersSchema = z
  .record(z.string(), z.string())
  .superRefine((headers, ctx) => {
    const entries = Object.entries(headers);

    if (entries.length > MAX_HEADERS) {
      ctx.addIssue({
        code: 'custom',
        message: `must contain at most ${String(MAX_HEADERS)} headers`,
      });
    }

    for (const [name, value] of entries) {
      const lowered = name.toLowerCase();

      if (FORBIDDEN_HEADER_NAMES.has(lowered)) {
        ctx.addIssue({
          code: 'custom',
          message: `must not contain the secret-bearing header "${name}"`,
        });
        continue;
      }

      if (name.length > MAX_HEADER_NAME_LENGTH) {
        ctx.addIssue({ code: 'custom', message: 'header name is too long' });
      } else if (!HEADER_NAME_PATTERN.test(name)) {
        ctx.addIssue({
          code: 'custom',
          message: `header name "${name}" contains invalid characters`,
        });
      }

      if (value.length > MAX_HEADER_VALUE_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          message: `value of header "${name}" is too long`,
        });
      } else if (!HEADER_VALUE_PATTERN.test(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `value of header "${name}" contains invalid characters`,
        });
      }
    }
  });

/**
 * Why a guarded URL was refused, in words a client can act on.
 *
 * The guard's own reasons are internal identifiers; these are the public
 * translation. Nothing here reveals more than the caller already sent us.
 */
const URL_REJECTION_MESSAGES: Record<UrlRejection, string> = {
  too_long: 'must be at most 2048 characters',
  unparseable: 'must be a valid URL',
  no_hostname: 'must be a valid URL',
  scheme_not_allowed: 'must start with http:// or https://',
  credentials_in_url: 'must not contain a username or password',
  port_not_allowed: 'must use port 80 for http:// or port 443 for https://',
  address_not_allowed: 'must not point at a blocked IP address',
};

/**
 * The URL to monitor.
 *
 * Scheme and length mirror the table's CHECK constraint, and the static half of
 * the SSRF gate is applied here by calling the very same {@link guardUrl} the
 * check pipeline runs. Not a copy of its rules — the function itself, so there
 * is exactly one static policy and no way for the two to drift apart.
 *
 * This is deliberately only the *static* half. No DNS lookup and no outbound
 * request happens during CRUD: a hostname's addresses are not a property of the
 * URL, they are a property of the moment it is fetched, and a name can be
 * re-pointed at any time after we store it. Address validation therefore stays
 * where it is authoritative — at check time, on every attempt and every
 * redirect hop.
 *
 * What this does buy is honesty at the boundary: a URL the check pipeline would
 * reject on every single run is now a 400 at creation, instead of a monitor
 * that exists only to record permanent failures.
 */
const urlSchema = z
  .string()
  .trim()
  // Not lowercased wholesale: paths and query strings are case-sensitive, so
  // normalising them would monitor a different endpoint than the user asked
  // for.
  .max(2048, 'must be at most 2048 characters')
  // The scheme, however, is case-insensitive per RFC 3986, while the table's
  // CHECK (`url ~ '^https?://'`) is case-sensitive. Without this, `HTTPS://x`
  // passes validation and then dies on the constraint — a valid URL rejected
  // with the wrong reason. Normalising here makes the schema and the database
  // agree on exactly one representation.
  .transform((value) =>
    value.replace(
      /^(https?):\/\//i,
      (_match, scheme: string) => `${scheme.toLowerCase()}://`,
    ),
  )
  .refine((value) => /^https?:\/\//.test(value), {
    message: 'must start with http:// or https://',
  })
  .superRefine((value, ctx) => {
    const verdict = guardUrl(value);

    if (!verdict.ok) {
      ctx.addIssue({
        code: 'custom',
        message: URL_REJECTION_MESSAGES[verdict.reason],
      });
    }
  });

const nameSchema = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(100, 'must be at most 100 characters');

/**
 * Plain `z.number()`, never `z.coerce.number()`.
 *
 * A JSON body already carries real types, so coercion buys nothing and costs
 * correctness: it would accept `"200"`, and also `true` as 1 and `[]` as 0.
 * Coercion belongs to environment variables, which are always strings.
 */
const expectedStatusSchema = z
  .number()
  .int()
  .min(100, 'must be between 100 and 599')
  .max(599, 'must be between 100 and 599');

const intervalSecondsSchema = z
  .number()
  .int()
  .positive('must be greater than 0')
  // A day is a generous ceiling; the point is that the column is an integer
  // and an absurd value should fail here rather than overflow later.
  .max(86_400, 'must be at most 86400 seconds');

const timeoutMsSchema = z
  .number()
  .int()
  .min(1000, 'must be between 1000 and 30000')
  .max(30_000, 'must be between 1000 and 30000');

/** V1 executes GET only, matching the table's CHECK. */
const methodSchema = z.literal('GET');

/**
 * `strictObject`, not `object`: an unknown key is a 400.
 *
 * This is mass-assignment protection. With a permissive object, a caller
 * sending `"user_id"` or `"id"` is one careless spread-into-SQL refactor away
 * from writing a field we never meant to expose. Rejecting unknown keys means
 * that attack never has a foothold.
 */
export const createMonitorSchema = z
  .strictObject({
    name: nameSchema,
    url: urlSchema,
    method: methodSchema.default('GET'),
    expectedStatus: expectedStatusSchema.default(200),
    intervalSeconds: intervalSecondsSchema,
    timeoutMs: timeoutMsSchema,
    headers: headersSchema.default({}),
    active: z.boolean().default(true),
  })
  // Cross-column rule, mirroring the table constraint: a check must finish
  // before the next one is due, or checks overlap and the queue grows without
  // bound. Both values are always present on create, so it can be checked here.
  .refine((input) => input.timeoutMs <= input.intervalSeconds * 1000, {
    message: 'timeoutMs must not exceed intervalSeconds * 1000',
    path: ['timeoutMs'],
  });

/**
 * Every field optional, but at least one required.
 *
 * An empty body is a 400 rather than a no-op 200: a silent success hides a
 * client bug instead of reporting it.
 *
 * The cross-field rule is deliberately *not* checked here — a PATCH carrying
 * only `timeoutMs` must be validated against the stored `intervalSeconds`. That
 * is enforced by the table constraint on the single UPDATE statement, which
 * cannot race the way a read-modify-write would.
 */
export const patchMonitorSchema = z
  .strictObject({
    name: nameSchema.optional(),
    url: urlSchema.optional(),
    method: methodSchema.optional(),
    expectedStatus: expectedStatusSchema.optional(),
    intervalSeconds: intervalSecondsSchema.optional(),
    timeoutMs: timeoutMsSchema.optional(),
    headers: headersSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'must contain at least one field to update',
  });

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type PatchMonitorInput = z.infer<typeof patchMonitorSchema>;
