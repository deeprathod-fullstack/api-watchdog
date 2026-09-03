import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError, NotFoundError } from '../errors.js';

/** Terminal middleware: any request that matched no route is a 404. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError());
};

/**
 * Client errors thrown by Express middleware rather than by our own code.
 *
 * Express and body-parser follow the `http-errors` convention: a 4xx `status`
 * together with `expose: true` means the error is safe to return to the client.
 * Without this, a request that is too large or contains malformed JSON would be
 * reported as a 500 — misleading the caller and, worse, logging the caller's
 * mistake as a server fault, which produces false alarms in monitoring.
 */
function asExposableClientError(
  err: unknown,
): { statusCode: number; code: string; message: string } | null {
  if (typeof err !== 'object' || err === null) return null;

  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
    type?: unknown;
    message?: unknown;
  };

  if (candidate.expose !== true) return null;

  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;

  if (status === undefined || status < 400 || status >= 500) return null;

  return {
    statusCode: status,
    // body-parser uses dotted types such as `entity.too.large`; normalise them
    // to the snake_case codes the rest of the API returns.
    code:
      typeof candidate.type === 'string'
        ? candidate.type.replaceAll('.', '_')
        : 'bad_request',
    message:
      typeof candidate.message === 'string' ? candidate.message : 'Bad request',
  };
}

/**
 * Central error handler.
 *
 * Known {@link AppError}s and exposable middleware client errors are returned
 * to the caller. Anything else is logged server-side and answered with a
 * generic 500 — internal messages and stack traces must never reach a client,
 * since they leak implementation details and sometimes credentials.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  const clientError = asExposableClientError(err);
  if (clientError) {
    res.status(clientError.statusCode).json({
      error: { code: clientError.code, message: clientError.message },
    });
    return;
  }

  // TODO(phase-4): replace with structured logging once that is introduced.
  console.error('Unhandled error:', err);

  res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error' },
  });
};
