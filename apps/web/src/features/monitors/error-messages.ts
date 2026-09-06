import { userErrorMessage } from '../../lib/error-message.js';

/**
 * The codes that mean something specific to monitors.
 *
 * Everything else — network failure, rate limiting, an expired session, a
 * server error — is worded by the shared translator, so those messages stay
 * identical across the app.
 */
const MONITOR_MESSAGES: Record<string, string> = {
  not_found:
    'That monitor no longer exists. It may have been deleted in another tab.',
  monitor_limit_reached:
    'You have reached the maximum number of monitors. Delete one to add another.',
};

export function monitorErrorMessage(error: unknown): string {
  return userErrorMessage(error, MONITOR_MESSAGES);
}

/**
 * Manual checks have their own, stricter limiter on the backend (ten per five
 * minutes), and saying "a few minutes" there would understate the wait.
 */
export function manualCheckErrorMessage(error: unknown): string {
  return userErrorMessage(error, {
    ...MONITOR_MESSAGES,
    rate_limited:
      'Too many manual checks. This is limited to a few per minute — try again shortly.',
  });
}
