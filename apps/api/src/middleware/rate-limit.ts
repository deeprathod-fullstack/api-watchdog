import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';

/**
 * Rate limiter for the credential endpoints.
 *
 * These two routes are the ones where abuse is cheap and costly: login is the
 * target of credential stuffing, and both endpoints run a deliberately
 * expensive bcrypt hash, so unmetered traffic is also a CPU-exhaustion vector
 * against the whole API.
 *
 * The store is in-memory, which means the limit is *per process*. That is
 * honest for a single-container deployment; the moment we run more than one API
 * instance the effective limit multiplies, and the fix is the Redis store
 * (Redis arrives with the worker in phase 2).
 *
 * Behind a proxy or load balancer this also needs Express's `trust proxy` set,
 * or every request appears to come from the proxy's address and one caller's
 * limit throttles everybody.
 */
export function createAuthRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Match the error envelope the rest of the API returns, so a client has one
    // shape to parse.
    message: {
      error: {
        code: 'rate_limited',
        message: 'Too many requests, please try again later',
      },
    },
  });
}
