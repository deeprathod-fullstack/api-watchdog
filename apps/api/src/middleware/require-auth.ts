import type { RequestHandler } from 'express';
import type pg from 'pg';

import { type Config } from '@api-watchdog/shared';

import { findUserById } from '../auth/repository.js';
import { toPublicUser } from '../auth/service.js';
import { UnauthenticatedError } from '../errors.js';
import { verifyAccessToken } from '../auth/token.js';

/** Extract the token from `Authorization: Bearer <token>`. */
function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;

  const [scheme, token, ...rest] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    return null;
  }

  return token;
}

/**
 * Reject any request that does not carry a valid token for an existing user.
 *
 * Two steps, both necessary:
 *
 * 1. Verify the signature and expiry — cryptography alone, no I/O.
 * 2. Load the user by id. A valid signature only proves *we issued this*, not
 *    that the account still exists. Without the lookup, a deleted user's token
 *    keeps working until it expires, and handlers would be trusting an id that
 *    no longer resolves to anything. It is one primary-key lookup; correctness
 *    is worth the query.
 *
 * Note what this middleware does *not* do: it says nothing about whether the
 * caller may touch a particular resource. Ownership is enforced per query, in
 * the SQL `WHERE` clause of the monitor routes.
 */
export function requireAuth(db: pg.Pool, config: Config): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = readBearerToken(req.get('authorization'));
      if (!token) {
        next(new UnauthenticatedError());
        return;
      }

      const userId = verifyAccessToken(token, config);
      if (!userId) {
        next(new UnauthenticatedError());
        return;
      }

      const user = await findUserById(db, userId);
      if (!user) {
        next(new UnauthenticatedError());
        return;
      }

      req.auth = {
        userId: user.id,
        email: user.email,
        user: toPublicUser(user),
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}
