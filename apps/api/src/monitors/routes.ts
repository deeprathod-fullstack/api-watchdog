import { Router, type Request, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';

import { type Config } from '@api-watchdog/shared';

import {
  type CheckExecutor,
  runManualCheck,
  toCheckResultResponse,
} from '../checks/service.js';
import { NotFoundError, UnauthenticatedError } from '../errors.js';
import { requireAuth } from '../middleware/require-auth.js';
import { parseBody } from '../validation.js';
import { findMonitor } from './repository.js';
import { createMonitorSchema, patchMonitorSchema } from './schemas.js';
import {
  createMonitor,
  getMonitor,
  getMonitors,
  patchMonitor,
  removeMonitor,
} from './service.js';

const monitorIdSchema = z.uuid();

/**
 * The authenticated caller's id.
 *
 * `req.auth` is optional in the type system so no route can silently assume
 * it; behind the router-level `requireAuth` it is always set, and this turns
 * that guarantee into a value without repeating the check in five handlers.
 */
function callerId(req: Request): string {
  if (!req.auth) throw new UnauthenticatedError();

  return req.auth.userId;
}

/**
 * Read `:id` as a UUID, or 404.
 *
 * A malformed id must never reach PostgreSQL, where it becomes
 * `22P02 invalid input syntax for uuid` and a 500. Answering 404 rather than
 * 400 also gives these endpoints exactly one negative outcome, so no later
 * change can make the distinction between "invalid", "missing" and "someone
 * else's" observable.
 */
function monitorId(req: Request): string {
  const result = monitorIdSchema.safeParse(req.params.id);

  if (!result.success) throw new NotFoundError('Monitor not found');

  return result.data;
}

/**
 * Build the monitor routes.
 *
 * `requireAuth` is applied to the whole router, so a route added later cannot
 * forget to be authenticated. Ownership deliberately is *not* handled that way:
 * "which resource" differs in every statement, so it lives in each query's
 * `WHERE` clause instead — see the repository.
 */
export interface MonitorsRouterDependencies {
  db: pg.Pool;
  config: Config;
  /** Applied to monitor creation. */
  createRateLimiter: RequestHandler;
  /** Applied to manual checks; deliberately stricter. */
  manualCheckRateLimiter: RequestHandler;
  /** The guard, resolver and HTTP client a manual check runs through. */
  checkExecutor: CheckExecutor;
}

export function createMonitorsRouter({
  db,
  config,
  createRateLimiter,
  manualCheckRateLimiter,
  checkExecutor,
}: MonitorsRouterDependencies): Router {
  const router = Router();

  router.use('/api/monitors', requireAuth(db, config));

  router.post('/api/monitors', createRateLimiter, async (req, res) => {
    const input = parseBody(createMonitorSchema, req.body);
    const monitor = await createMonitor(db, callerId(req), input);

    res.status(201).location(`/api/monitors/${monitor.id}`).json({ monitor });
  });

  // Enveloped rather than a bare array: a top-level JSON array is a dead end,
  // so adding pagination metadata later would be a breaking change.
  router.get('/api/monitors', async (req, res) => {
    const monitors = await getMonitors(db, callerId(req));

    res.status(200).json({ monitors });
  });

  router.get('/api/monitors/:id', async (req, res) => {
    const monitor = await getMonitor(db, callerId(req), monitorId(req));

    res.status(200).json({ monitor });
  });

  router.patch('/api/monitors/:id', async (req, res) => {
    const patch = parseBody(patchMonitorSchema, req.body);
    const monitor = await patchMonitor(
      db,
      callerId(req),
      monitorId(req),
      patch,
    );

    res.status(200).json({ monitor });
  });

  router.delete('/api/monitors/:id', async (req, res) => {
    await removeMonitor(db, callerId(req), monitorId(req));

    res.status(204).end();
  });

  /**
   * Run one check now and store the result.
   *
   * A 200 means the check operation ran and was persisted — not that the
   * monitored endpoint was healthy. Reporting a failed target as 502 or 504
   * would conflate our API's health with theirs and make the frontend's error
   * handling lie.
   *
   * The rate limiter is the first thing in this chain, so it runs before the
   * database read and long before any outbound packet.
   */
  router.post(
    '/api/monitors/:id/check',
    manualCheckRateLimiter,
    async (req, res) => {
      const userId = callerId(req);
      const id = monitorId(req);

      const monitor = await findMonitor(db, userId, id);
      // 404, not 403: a monitor belonging to someone else must be
      // indistinguishable from one that does not exist.
      if (!monitor) throw new NotFoundError('Monitor not found');

      // `monitor.active` is deliberately not consulted: pausing stops the
      // future scheduler, and checking a paused monitor by hand is the main
      // reason this endpoint exists.
      const check = await runManualCheck(db, checkExecutor, monitor, userId);

      res.status(200).json({ check: toCheckResultResponse(check) });
    },
  );

  return router;
}
