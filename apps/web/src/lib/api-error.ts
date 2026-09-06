/**
 * A failed API call, in the one shape the whole frontend handles.
 *
 * The backend answers every error with `{ error: { code, message } }`, where
 * `code` is stable and machine-readable and `message` is already vetted as safe
 * to show. Screens branch on `code`; they never match on message text.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
    /** Carries the transport failure when there was never a response. */
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.cause = options?.cause;
  }

  /** The caller's token is missing, expired or rejected. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** The request never reached the API (offline, DNS, CORS, abort). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

/** Message shown instead of a server error the user can do nothing with. */
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Turn an error response body into an {@link ApiError}.
 *
 * Two rules matter here. A body we do not recognise is *not* forwarded to the
 * user — an unexpected shape usually means a proxy or crash page, and dumping
 * it on screen leaks infrastructure detail. And any 5xx is reported
 * generically, because a server-side message is written for operators.
 */
export function toApiError(status: number, body: unknown): ApiError {
  const parsed = parseErrorBody(body);

  if (!parsed) {
    return new ApiError(status, fallbackCode(status), GENERIC_MESSAGE);
  }

  return new ApiError(
    status,
    parsed.code,
    status >= 500 ? GENERIC_MESSAGE : parsed.message,
  );
}

function fallbackCode(status: number): string {
  return status >= 500 ? 'internal_error' : 'request_failed';
}

function parseErrorBody(
  body: unknown,
): { code: string; message: string } | null {
  if (typeof body !== 'object' || body === null) return null;

  const { error } = body as { error?: unknown };
  if (typeof error !== 'object' || error === null) return null;

  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') return null;

  return { code, message };
}
