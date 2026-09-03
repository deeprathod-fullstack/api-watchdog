import { Router } from 'express';

export const healthRouter = Router();

/**
 * Liveness probe: "is this process alive?"
 *
 * Deliberately checks NO dependencies. If a liveness probe queried the
 * database, a brief database outage would make the platform conclude the
 * application is dead and restart it — turning a small incident into a restart
 * storm.
 *
 * A readiness probe (`GET /ready`, "can this process serve traffic?") is the
 * place for dependency checks. It arrives with the database.
 */
healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
