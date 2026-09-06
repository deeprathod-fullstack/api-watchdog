/**
 * The closed set of classifiers `check_results.error_type` may hold, and the
 * words we show for each.
 *
 * Mirrors `CheckErrorType` in `apps/api/src/checks/classify.ts`. It lives in
 * `lib` rather than in one feature because the manual-check summary and the
 * history table both render it, and two copies of this table would drift into
 * describing the same failure differently on two screens.
 */
export const CHECK_ERROR_LABELS: Record<string, string> = {
  status_mismatch: 'Unexpected status',
  timeout: 'Timed out',
  dns: 'DNS lookup failed',
  connection_refused: 'Connection refused',
  connection_error: 'Connection error',
  tls: 'TLS error',
  blocked_url: 'URL blocked by policy',
  blocked_address: 'Address blocked by policy',
  too_many_redirects: 'Too many redirects',
  invalid_response: 'Invalid response',
  unknown: 'Unknown error',
};

/** A human label for a classifier, without inventing new categories. */
export function checkErrorLabel(errorType: string | null): string | null {
  if (errorType === null) return null;

  return CHECK_ERROR_LABELS[errorType] ?? 'Check failed';
}

/**
 * What to say when a failed check carries no message.
 *
 * The backend writes a message for most failures, but the column is nullable,
 * and a row with a classifier and no prose should still explain itself. These
 * describe the classifier — they never guess at detail the check did not
 * record.
 */
const FALLBACK_DESCRIPTIONS: Record<string, string> = {
  status_mismatch:
    'The endpoint returned a status other than the expected one.',
  timeout: 'No response arrived before the monitor’s timeout.',
  dns: 'The hostname could not be resolved.',
  connection_refused: 'The host refused the connection.',
  connection_error: 'The connection could not be established.',
  tls: 'The TLS handshake failed.',
  blocked_url: 'The URL is not allowed by the checking policy.',
  blocked_address:
    'The resolved address is not allowed by the checking policy.',
  too_many_redirects:
    'The endpoint redirected more times than the checker follows.',
  invalid_response: 'The response could not be understood.',
  unknown: 'The check failed for an unrecognised reason.',
};

export function checkErrorDescription(errorType: string | null): string | null {
  if (errorType === null) return null;

  return FALLBACK_DESCRIPTIONS[errorType] ?? 'The check failed.';
}
