import bcrypt from 'bcrypt';

/**
 * bcrypt work factor.
 *
 * bcrypt is deliberately slow: cost 12 means 2^12 key-expansion rounds, on the
 * order of 200-400ms per hash on current hardware. That is irrelevant once per
 * login and ruinous for an attacker running an offline dictionary against a
 * stolen table — the whole point of a password KDF is that it cannot be
 * accelerated the way SHA-256 can.
 *
 * The cost is stored inside the hash string, so it can be raised later and
 * existing hashes still verify.
 */
export const BCRYPT_COST = 12;

/**
 * bcrypt hashes at most the first 72 bytes of input and silently ignores the
 * rest. Rejecting longer passwords at the boundary makes the limit explicit
 * instead of pretending a 200-character passphrase is fully used.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * A real cost-12 hash of a random string that is not any user's password.
 *
 * Used to make the "no such user" login path do the same expensive comparison
 * as the "wrong password" path. Without it, a missing account answers in ~1ms
 * and an existing one in ~300ms, which leaks exactly the account existence the
 * generic 401 message is there to hide.
 */
const DUMMY_HASH =
  '$2b$12$qbKC5/Wjaxbw25bCGD4Vku4NRGxgjRsl3Cww0.7DbrJAGdDCP8KYS';

/** Hash a plaintext password. The plaintext is never stored or logged. */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Verify a plaintext password against a stored hash. */
export function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

/**
 * Burn the same CPU time a real verification would, and always fail.
 *
 * Call this on the login path when no user matched, so response time does not
 * distinguish "unknown email" from "known email, wrong password".
 */
export async function verifyPasswordAgainstDummy(
  password: string,
): Promise<void> {
  await bcrypt.compare(password, DUMMY_HASH);
}
