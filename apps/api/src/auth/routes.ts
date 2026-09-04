import { Router, type RequestHandler } from 'express';
import type pg from 'pg';

import { type Config } from '@api-watchdog/shared';

import { requireAuth } from '../middleware/require-auth.js';
import { parseBody } from '../validation.js';
import { loginSchema, registerSchema } from './schemas.js';
import { loginUser, registerUser } from './service.js';
import { UnauthenticatedError } from '../errors.js';

/**
 * Build the auth routes.
 *
 * The rate limiter is injected rather than created here so tests can drive the
 * endpoints without tripping it, and so the limiter's storage choice stays a
 * decision of the process entry point.
 */
export function createAuthRouter(
  db: pg.Pool,
  config: Config,
  authRateLimiter: RequestHandler,
): Router {
  const router = Router();

  router.post('/api/auth/register', authRateLimiter, async (req, res) => {
    const input = parseBody(registerSchema, req.body);
    const result = await registerUser(db, config, input);

    res.status(201).json(result);
  });

  router.post('/api/auth/login', authRateLimiter, async (req, res) => {
    const input = parseBody(loginSchema, req.body);
    const result = await loginUser(db, config, input);

    res.status(200).json(result);
  });

  /**
   * The frontend calls this on page load to turn a stored token back into a
   * session, and to find out that a token has expired before it renders a
   * dashboard that cannot load.
   */
  router.get('/api/auth/me', requireAuth(db, config), (req, res, next) => {
    // `auth` is optional in the type system so that a route cannot silently
    // assume it. Here it is always set, because the middleware above either
    // sets it or fails the request.
    if (!req.auth) {
      next(new UnauthenticatedError());
      return;
    }

    res.status(200).json({ user: req.auth.user });
  });

  return router;
}
