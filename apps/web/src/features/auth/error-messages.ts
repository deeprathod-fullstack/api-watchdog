import { ApiError } from '../../lib/api-error.js';

/**
 * Turn a failed auth request into something worth showing a person.
 *
 * The mapping is on the backend's stable `code`, never on message text. Two
 * codes are deliberately rewritten rather than passed through:
 *
 * - `invalid_credentials` gets one message for both "no such account" and
 *   "wrong password". The backend already refuses to distinguish them, and a
 *   frontend that helpfully said "no account with that email" would hand the
 *   account-existence oracle back to an attacker at the last step.
 * - `validation_failed` is not shown verbatim. The backend's detail string is
 *   a list of field paths written for a developer; the forms validate the same
 *   rules client-side, so reaching here means something the form did not
 *   anticipate, and a generic prompt beats leaking the schema's shape.
 *
 * Anything unrecognised falls through to a generic message. `ApiError` has
 * already replaced 5xx bodies and unparseable ones, so nothing internal can
 * reach a user through this path.
 */
export function authErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }

  if (error.isNetworkError) {
    return 'Unable to reach API Watchdog. Please try again.';
  }

  switch (error.code) {
    case 'invalid_credentials':
      return 'Invalid email or password.';
    case 'email_taken':
      return 'An account with this email already exists.';
    case 'rate_limited':
      return 'Too many attempts. Please try again later.';
    case 'validation_failed':
      return 'Please check the details you entered and try again.';
    case 'unauthenticated':
      return 'Your session has expired. Please sign in again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
