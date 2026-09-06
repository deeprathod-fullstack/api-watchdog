import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

import { loadConfig, loadDotenv } from '@api-watchdog/shared';

import { createCheckClient } from './checks/http-client.js';
import { resolveSafely, systemResolver } from './checks/safe-lookup.js';
import { runScheduledCheck } from './checks/scheduled.js';
import { guardUrl } from './checks/url-guard.js';
import { closePool, getPool } from './db/pool.js';
import { CHECKS_QUEUE_NAME, type CheckJobData } from './queue/checks-queue.js';
import { createRedisConnection } from './queue/connection.js';

/**
 * The background worker: the process that actually checks monitors.
 *
 * Separate from the API for one reason above all others. A check is an outbound
 * request to a host a stranger chose — slow, unpredictable, occasionally
 * hostile. Running those on the event loop that serves the dashboard means one
 * tarpit target degrades the API for every user. Splitting them also means the
 * two can be restarted, and eventually scaled, independently.
 *
 * It is a separate *process*, not a separate service: same repository, same
 * code, same database. There is no network API between them and no second thing
 * to deploy independently. The queue is the entire interface.
 */

/** Grace period for in-flight checks before the process is forced down. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Checks to run at once.
 *
 * More than one, because a check is almost entirely waiting on a socket and
 * serialising them would let a single slow target hold up every other monitor's
 * schedule. Not many more, because each concurrent check holds a PostgreSQL
 * connection while it records its result, and the pool is sized in config.
 */
const CONCURRENCY = 5;

loadDotenv();

// Fail fast: a worker with a bad configuration should die at startup, where a
// deploy reports it, rather than silently failing every check.
const config = loadConfig();

const db = getPool(config);
const redis = createRedisConnection(config);

/**
 * The production SSRF pipeline, assembled exactly as the API assembles it.
 *
 * The same static guard, the same resolver, the same client built over both.
 * The worker is the process that makes the most outbound requests, so it is the
 * last place that should have its own copy of any of this — and there is no
 * configuration path to a permissive variant here either.
 */
const resolve = (hostname: string) => resolveSafely(hostname, systemResolver);
const checkExecutor = {
  guard: guardUrl,
  resolve,
  client: createCheckClient({ resolve }),
};

const worker = new Worker<CheckJobData>(
  CHECKS_QUEUE_NAME,
  async (job: Job<CheckJobData>) => {
    // The job carries an id and nothing else; `runScheduledCheck` reads the
    // monitor back from PostgreSQL before doing anything with it.
    return runScheduledCheck(db, checkExecutor, job.data.monitorId);
  },
  { connection: redis, concurrency: CONCURRENCY },
);

/**
 * Report a failed job without leaking what failed.
 *
 * A check that fails is not an error — it is a result, already classified and
 * stored. Reaching here means the *machinery* broke: the database was
 * unreachable, or a bug threw. Only the message is logged, never the error
 * object, whose stack and properties can carry a URL, a header, or a connection
 * string.
 */
worker.on('failed', (job, error) => {
  console.error(
    JSON.stringify({
      event: 'check_job_failed',
      jobId: job?.id ?? null,
      monitorId: job?.data.monitorId ?? null,
      message: error.message,
    }),
  );
});

worker.on('error', (error) => {
  console.error(
    JSON.stringify({ event: 'worker_error', message: error.message }),
  );
});

console.log(
  `worker listening on queue ${CHECKS_QUEUE_NAME} (env: ${config.NODE_ENV}, concurrency: ${String(CONCURRENCY)})`,
);

/**
 * Shut down cleanly on SIGTERM/SIGINT.
 *
 * Every deployment sends SIGTERM. `worker.close()` stops the worker taking new
 * jobs and waits for the checks already running to finish, so a redeploy does
 * not abandon a check halfway through its transaction and leave the job to be
 * redelivered.
 *
 * The grace period is longer than the API's, because a check in flight may be
 * sitting on a monitor's full timeout.
 */
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down worker`);

  const forceExit = setTimeout(() => {
    console.error('Worker shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // Do not keep the event loop alive purely for the timeout.
  forceExit.unref();

  void closeResources().then(
    () => {
      clearTimeout(forceExit);
      console.log('Worker shutdown complete');
      process.exit(0);
    },
    (error: unknown) => {
      clearTimeout(forceExit);
      console.error('Error during worker shutdown:', error);
      process.exit(1);
    },
  );
}

/**
 * Drain in order: jobs, then Redis, then PostgreSQL.
 *
 * The worker first, because it needs both connections to finish the checks it
 * is already running. Then Redis, then the pool — the process holds sockets to
 * both and will not exit on its own until each is released.
 */
async function closeResources(): Promise<void> {
  await worker.close();
  await redis.quit();
  await closePool();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
