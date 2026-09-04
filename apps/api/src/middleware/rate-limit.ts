import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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

/**
 * Rate limiter for monitor creation.
 *
 * Looser than the credential limiter — creating monitors is normal use, not a
 * credential guess — but not unlimited: each monitor is recurring outbound
 * traffic we will generate against a third party, so unmetered creation makes
 * this service a convenient traffic amplifier. The per-user cap bounds the
 * total; this bounds the rate of getting there.
 */
export function createMonitorRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'rate_limited',
        message: 'Too many requests, please try again later',
      },
    },
  });
}

/**
 * Rate limiter for manual "check now" requests.
 *
 * Much tighter than monitor creation, because this is the endpoint that turns
 * one authenticated call into one outbound request to a host the caller chose.
 * That makes it a traffic amplifier and a denial-of-service-by-proxy vector
 * with our IP as the apparent source, so the ceiling is set by what we could
 * defend to an abuse desk rather than by what feels convenient: 10 checks per
 * 5 minutes is two a minute, ample for a human debugging a monitor.
 *
 * Keyed per user, not per IP: IP keying pools everyone behind one NAT into a
 * shared bucket, letting one user starve the rest. The IP fallback is only ever
 * reached by unauthenticated traffic, which `requireAuth` has already rejected
 * before this middleware runs.
 */
export function createManualCheckRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (request) =>
      request.auth?.userId ?? ipKeyGenerator(request.ip ?? ''),
    message: {
      error: {
        code: 'rate_limited',
        message: 'Too many manual checks, please try again later',
      },
    },
  });
}
