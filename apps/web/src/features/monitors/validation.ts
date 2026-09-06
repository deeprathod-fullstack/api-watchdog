/**
 * UX validation for the monitor form.
 *
 * Read this first: **none of this is a security control.** The backend
 * validates every one of these rules with Zod, and its URL check calls the very
 * same `guardUrl` the check pipeline runs, plus DNS-time address rules that a
 * browser cannot evaluate and must not pretend to. The SSRF boundary is on the
 * server, at check time, on every attempt and every redirect hop.
 *
 * What this buys is a fast, specific answer instead of a round trip — and it
 * keeps obviously-wrong input from spending one of the thirty monitor creates
 * the rate limiter allows per fifteen minutes. Where the two disagree, the
 * backend wins and its message is shown.
 *
 * The bounds below mirror `apps/api/src/monitors/schemas.ts`.
 */

export const NAME_MAX_LENGTH = 100;
export const URL_MAX_LENGTH = 2048;
export const EXPECTED_STATUS_MIN = 100;
export const EXPECTED_STATUS_MAX = 599;
export const INTERVAL_MIN_SECONDS = 1;
export const INTERVAL_MAX_SECONDS = 86_400;
export const TIMEOUT_MIN_MS = 1000;
export const TIMEOUT_MAX_MS = 30_000;

/**
 * The header names this UI offers.
 *
 * A deliberately short allowlist, not a free-text field. The backend rejects
 * the secret-bearing names outright, but offering an open input would invite
 * users to try putting an API key in one — and monitor headers are stored in
 * plaintext in a table that gets backed up and read by support queries. The
 * safest credential field is the one that does not exist.
 */
export const ALLOWED_HEADER_NAMES = [
  'Accept',
  'User-Agent',
  'X-Environment',
] as const;

export type AllowedHeaderName = (typeof ALLOWED_HEADER_NAMES)[number];

/** Matches the backend's cap. */
export const MAX_HEADERS = 10;
export const HEADER_VALUE_MAX_LENGTH = 1024;

export function validateName(value: string): string | undefined {
  const name = value.trim();

  if (!name) return 'Name is required.';
  if (name.length > NAME_MAX_LENGTH) {
    return `Name must be at most ${String(NAME_MAX_LENGTH)} characters.`;
  }

  return undefined;
}

/**
 * The parts of the backend's URL policy a browser can honestly check.
 *
 * Scheme, credentials, port and length — all properties of the string itself.
 * Deliberately *not* checked here: whether the hostname resolves to a private
 * address. That is not a property of the URL, it is a property of the moment it
 * is fetched, and a name can be re-pointed at any time after we store it. A
 * client-side copy of that rule would be both wrong and reassuring, which is
 * the worst combination.
 */
export function validateUrl(value: string): string | undefined {
  const raw = value.trim();

  if (!raw) return 'URL is required.';
  if (raw.length > URL_MAX_LENGTH) {
    return `URL must be at most ${String(URL_MAX_LENGTH)} characters.`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a valid URL, including http:// or https://';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'URL must start with http:// or https://';
  }

  if (url.username || url.password) {
    return 'URL must not contain a username or password.';
  }

  // The backend allows only the default port for each scheme.
  if (url.port) {
    const expected = url.protocol === 'https:' ? '443' : '80';
    if (url.port !== expected) {
      return 'URL must use port 80 for http:// or port 443 for https://';
    }
  }

  return undefined;
}

/**
 * Parse a numeric form field.
 *
 * Number inputs hand back strings, and an empty one is `''`. `Number('')` is 0,
 * which would silently submit a zero the user never typed, so parsing is
 * explicit.
 */
function parseInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return null;

  return parsed;
}

export function validateExpectedStatus(value: string): string | undefined {
  const parsed = parseInteger(value);

  if (parsed === null) return 'Expected status is required.';
  if (parsed < EXPECTED_STATUS_MIN || parsed > EXPECTED_STATUS_MAX) {
    return `Expected status must be between ${String(EXPECTED_STATUS_MIN)} and ${String(EXPECTED_STATUS_MAX)}.`;
  }

  return undefined;
}

export function validateInterval(value: string): string | undefined {
  const parsed = parseInteger(value);

  if (parsed === null) return 'Check interval is required.';
  if (parsed < INTERVAL_MIN_SECONDS || parsed > INTERVAL_MAX_SECONDS) {
    return `Check interval must be between ${String(INTERVAL_MIN_SECONDS)} and ${String(INTERVAL_MAX_SECONDS)} seconds.`;
  }

  return undefined;
}

export function validateTimeout(
  value: string,
  intervalValue: string,
): string | undefined {
  const parsed = parseInteger(value);

  if (parsed === null) return 'Timeout is required.';
  if (parsed < TIMEOUT_MIN_MS || parsed > TIMEOUT_MAX_MS) {
    return `Timeout must be between ${String(TIMEOUT_MIN_MS)} and ${String(TIMEOUT_MAX_MS)} milliseconds.`;
  }

  // The backend enforces this too — as a table constraint, because a partial
  // PATCH does not carry both values. Catching it here explains it in the form
  // instead of as a server rejection.
  const interval = parseInteger(intervalValue);
  if (interval !== null && parsed > interval * 1000) {
    return 'Timeout must not be longer than the check interval.';
  }

  return undefined;
}

export function validateHeaderValue(value: string): string | undefined {
  const trimmed = value.trim();

  if (!trimmed) return 'Header value is required.';
  if (trimmed.length > HEADER_VALUE_MAX_LENGTH) {
    return `Header value must be at most ${String(HEADER_VALUE_MAX_LENGTH)} characters.`;
  }
  // Printable ASCII only. A newline in a header value splits it into extra
  // headers on the outbound request; the backend rejects this for that reason,
  // and saying so here is clearer than a 400.
  if (!/^[\x20-\x7e]*$/.test(trimmed)) {
    return 'Header value may only contain printable ASCII characters.';
  }

  return undefined;
}

/** Convenience for the form: the parsed number, or 0 if it was not valid. */
export function toInteger(value: string): number {
  return parseInteger(value) ?? 0;
}
