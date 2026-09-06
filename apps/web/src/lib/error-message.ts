import { ApiError } from './api-error.js';

/**
 * The default translation from a failed request to something worth reading.
 *
 * This is not a second error system — `ApiError` remains the single
 * representation, and this only chooses wording. It keys on the backend's
 * stable `code`, never on message text, and it is the shared fallback so that
 * "the network is down" or "you are being rate limited" reads the same
 * wherever it happens.
 *
 * A feature passes `overrides` for the codes that mean something specific to
 * it — `monitor_limit_reached`, say — rather than growing a switch here that
 * knows about every screen in the app.
 *
 * Nothing internal can escape through this path: `ApiError` has already
 * replaced 5xx bodies and unrecognised ones with generic text before any of
 * these branches see it.
 */
export function userErrorMessage(
  error: unknown,
  overrides: Record<string, string> = {},
): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }

  const override = overrides[error.code];
  if (override) return override;

  if (error.isNetworkError) {
    return 'Unable to reach API Watchdog. Please try again.';
  }

  switch (error.code) {
    case 'unauthenticated':
      return 'Your session has expired. Please sign in again.';
    case 'rate_limited':
      return 'Too many requests. Please try again in a few minutes.';
    case 'validation_failed':
      // The backend's detail string names field paths and rules and never
      // echoes submitted values, so it is safe to show and genuinely useful —
      // it is what tells a user *which* field the server rejected.
      return error.message;
    default:
      return 'Something went wrong. Please try again.';
  }
}
