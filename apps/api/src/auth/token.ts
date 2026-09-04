import jwt from 'jsonwebtoken';

import { type Config } from '@api-watchdog/shared';

/**
 * Access-token lifetime.
 *
 * A stateless JWT cannot be revoked: once signed it is valid until it expires,
 * so logout, a password change or an account deletion cannot invalidate an
 * outstanding token. The TTL is therefore the only bound on that exposure
 * window, which is why it is 24 hours rather than weeks.
 */
export const TOKEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * HS256: one shared secret, signed and verified by the same key.
 *
 * Pinned explicitly on both sign and verify. Accepting whatever algorithm the
 * token's own header claims is the classic JWT vulnerability — a caller could
 * present `alg: none`, or trick an RS256 verifier into treating the public key
 * as an HMAC secret. The verifier, not the token, decides the algorithm.
 */
const ALGORITHM = 'HS256';

/** The claims we put in a token, and the only ones we trust on the way back. */
interface AccessTokenPayload {
  sub: string;
}

/**
 * Sign an access token for a user.
 *
 * The payload carries the user id and nothing else. A JWT is signed, not
 * encrypted — anyone holding it can read the payload — and any copy of the
 * user's name or email inside it would also go stale the moment the record
 * changes. Identity data is loaded from the database instead.
 */
export function signAccessToken(userId: string, config: Config): string {
  return jwt.sign(
    { sub: userId } satisfies AccessTokenPayload,
    config.JWT_SECRET,
    {
      algorithm: ALGORITHM,
      expiresIn: TOKEN_TTL_SECONDS,
    },
  );
}

/**
 * Verify a token and return the user id it asserts, or `null` if it is not a
 * token we issued and still accept.
 *
 * Every failure — bad signature, expiry, wrong algorithm, garbage — collapses
 * into `null` on purpose: the caller has nothing to gain from the distinction
 * and an attacker would.
 */
export function verifyAccessToken(
  token: string,
  config: Config,
): string | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, {
      algorithms: [ALGORITHM],
    });

    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      return null;
    }

    return payload.sub;
  } catch {
    return null;
  }
}
