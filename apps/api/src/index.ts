import { createServer } from 'node:http';

import { loadConfig, loadDotenv } from '@api-watchdog/shared';

import { createApp } from './app.js';
import { createCheckClient } from './checks/http-client.js';
import { resolveSafely, systemResolver } from './checks/safe-lookup.js';
import { guardUrl } from './checks/url-guard.js';
import { getPool, closePool } from './db/pool.js';
import {
  BullMqScheduler,
  createChecksQueue,
  reconcileSchedules,
} from './queue/checks-queue.js';
import { createRedisConnection } from './queue/connection.js';
import {
  createAuthRateLimiter,
  createManualCheckRateLimiter,
  createMonitorRateLimiter,
} from './middleware/rate-limit.js';

/** Grace period for in-flight requests before the process is forced down. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

loadDotenv();

// Fail fast: a misconfigured process should never reach the point of accepting
// traffic, so that a bad deploy is reported as failed rather than serving 500s.
const config = loadConfig();

const db = getPool(config);

/**
 * The production SSRF pipeline, assembled once.
 *
 * The real static policy, the real resolver, and a client built over both.
 * There is no configuration path to a permissive variant of any of the three.
 */
const resolve = (hostname: string) => resolveSafely(hostname, systemResolver);
const checkExecutor = {
  guard: guardUrl,
  resolve,
  client: createCheckClient({ resolve }),
};

/**
 * The API's half of the queue: it writes schedules, it never runs checks.
 *
 * Keeping execution out of this process is the point of having a worker. An
 * outbound request to a stranger's host is slow, unpredictable, and occasionally
 * hostile; running those on the same event loop that serves the dashboard means
 * one slow target degrades the API for everybody.
 */
const redis = createRedisConnection(config);
const checksQueue = createChecksQueue(redis);
const scheduler = new BullMqScheduler(checksQueue);

const server = createServer(
  createApp({
    config,
    db,
    authRateLimiter: createAuthRateLimiter(),
    monitorRateLimiter: createMonitorRateLimiter(),
    manualCheckRateLimiter: createManualCheckRateLimiter(),
    checkExecutor,
    scheduler,
  }),
);

server.listen(config.PORT, () => {
  console.log(`api listening on port ${config.PORT} (env: ${config.NODE_ENV})`);
});

/**
 * Rebuild the schedules from PostgreSQL, once, at startup.
 *
 * This is what lets Redis be disposable. Schedules live there, but they are
 * derived data: every active monitor should have one and nothing else should.
 * A flushed Redis, a monitor written while Redis was unreachable, or a delete
 * whose scheduler removal failed all heal here instead of needing an operator.
 *
 * Deliberately not awaited before `listen`: the API is perfectly able to serve
 * requests without it, and refusing traffic because Redis is slow to answer
 * would turn a background concern into an outage.
 */
void reconcileSchedules(db, checksQueue).then(
  (report) => {
    console.log(JSON.stringify({ event: 'schedules_reconciled', ...report }));
  },
  (error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'schedule_reconcile_failed',
        message: error instanceof Error ? error.message : 'unknown error',
      }),
    );
  },
);

/**
 * Shut down cleanly on SIGTERM/SIGINT.
 *
 * Every deployment — Docker restart, CI redeploy, AWS instance replacement —
 * sends SIGTERM. Without this, the process dies mid-request. With it, we stop
 * accepting connections, drain in-flight work, then exit.
 */
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // Do not keep the event loop alive purely for the timeout.
  forceExit.unref();

  server.close((err) => {
    if (err) {
      clearTimeout(forceExit);
      console.error('Error during shutdown:', err);
      process.exit(1);
    }

    // Release the outbound connections last: the process keeps sockets open
    // to both PostgreSQL and Redis and will not exit on its own until each is
    // drained. The queue is closed before its Redis client, because closing
    // the client first leaves the queue's in-flight commands with no
    // connection to finish on.
    void closeResources().then(
      () => {
        clearTimeout(forceExit);
        console.log('Shutdown complete');
        process.exit(0);
      },
      (closeError: unknown) => {
        clearTimeout(forceExit);
        console.error('Error releasing resources:', closeError);
        process.exit(1);
      },
    );
  });
}

/** Close the queue, then Redis, then PostgreSQL. Order matters; see above. */
async function closeResources(): Promise<void> {
  await checksQueue.close();
  await redis.quit();
  await closePool();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
