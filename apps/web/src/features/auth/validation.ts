/**
 * Client-side validation for the credential forms.
 *
 * This is a usability layer, not a security control: the backend validates the
 * same rules with Zod and is the only authority. The value here is that a
 * typo is caught before a round trip, and before the auth rate limiter — ten
 * attempts per fifteen minutes — is spent on a request that could not succeed.
 *
 * The rules deliberately mirror `apps/api/src/auth/schemas.ts`. Where they
 * disagree the backend wins and the form shows its error.
 */

/** Matches the backend's `z.string().trim().min(1).max(100)`. */
export const NAME_MAX_LENGTH = 100;

/** Matches the backend's `passwordSchema` minimum. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Deliberately permissive.
 *
 * A form should reject "no @ sign at all", not adjudicate RFC 5322 — every
 * clever email regex ends up rejecting somebody's real address. Deliverability
 * is not knowable from a pattern anyway.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: string): string | undefined {
  const email = value.trim();

  if (!email) return 'Email is required.';
  if (!EMAIL_PATTERN.test(email)) return 'Enter a valid email address.';

  return undefined;
}

export function validateName(value: string): string | undefined {
  const name = value.trim();

  if (!name) return 'Name is required.';
  if (name.length > NAME_MAX_LENGTH) {
    return `Name must be at most ${NAME_MAX_LENGTH} characters.`;
  }

  return undefined;
}

/** Login only checks presence — see the note on `loginSchema`. */
export function validateLoginPassword(value: string): string | undefined {
  return value ? undefined : 'Password is required.';
}

export function validateNewPassword(value: string): string | undefined {
  if (!value) return 'Password is required.';
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }

  return undefined;
}

export function validatePasswordConfirmation(
  password: string,
  confirmation: string,
): string | undefined {
  if (!confirmation) return 'Confirm your password.';
  if (password !== confirmation) return 'Passwords do not match.';

  return undefined;
}
