import { type z } from 'zod';

import { ValidationError } from './errors.js';

/**
 * Parse an untrusted request payload against a schema, or fail with a 400.
 *
 * Every handler validates at the boundary and works with the parsed output
 * afterwards, so no unvalidated shape ever reaches the database or an outbound
 * request.
 *
 * The message reports field *paths* and rule descriptions, never the submitted
 * values: echoing input back is how a password ends up in a log line or an
 * error-tracking service.
 */
export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.output<T> {
  const result = schema.safeParse(body);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'} ${issue.message}`)
      .join('; ');

    throw new ValidationError(details);
  }

  return result.data;
}
