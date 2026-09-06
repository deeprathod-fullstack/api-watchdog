import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type pg from 'pg';

import type { CheckScheduler, SchedulableMonitor } from './scheduler.js';

/**
 * The BullMQ side of scheduling: one recurring job scheduler per active
 * monitor, plus the startup reconciliation that rebuilds them from PostgreSQL.
 */

/** The one queue in the system. Shared by the API (writer) and worker (reader). */
export const CHECKS_QUEUE_NAME = 'monitor-checks';

/** The job name inside that queue. */
export const CHECK_JOB_NAME = 'check';

/**
 * Everything a job carries.
 *
 * A monitor id and nothing else — no URL, no headers, no timeout, no expected
 * status. Three reasons, in order of importance:
 *
 * 1. Job data lives in Redis in plaintext and is visible to anything that can
 *    read the queue. Monitor headers are user-supplied and must not be copied
 *    into a second store; the rule that we never log a header value would mean
 *    little if the value sat in a Redis key instead.
 * 2. A queued job can be minutes old. Configuration copied at enqueue time is
 *    a stale snapshot, so a monitor edited or paused after the job was created
 *    would be checked with the old settings.
 * 3. It makes the worker's trust boundary a single value. Everything else is
 *    read back from PostgreSQL, which stays the only source of truth.
 */
export interface CheckJobData {
  readonly monitorId: string;
}

/**
 * The Redis key namespace the queue lives under.
 *
 * BullMQ's default. It is a parameter rather than a hard-coded string so the
 * test suite can run under a namespace of its own: a queue is identified by
 * prefix *and* name, so a worker a developer happens to have running locally
 * would otherwise consume the jobs the tests just enqueued — and the tests
 * would sit and wait for results that another process had already taken. That
 * is not a hypothetical; it is how this parameter came to exist.
 */
export const DEFAULT_QUEUE_PREFIX = 'bull';

export function createChecksQueue(
  connection: ConnectionOptions,
  prefix: string = DEFAULT_QUEUE_PREFIX,
): Queue {
  return new Queue(CHECKS_QUEUE_NAME, {
    connection,
    prefix,
    defaultJobOptions: {
      // A check that fails is not retried. The failure *is* the result: it has
      // already been classified and written to check_results, and a retry
      // would record a second row for the same scheduled instant and corrupt
      // the consecutive-failure streak the incident engine derives from it.
      attempts: 1,
      // Completed and failed jobs are kept only briefly. History belongs in
      // PostgreSQL; letting Redis accumulate a row per check per monitor
      // forever is how a queue turns into an unbounded store.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400, count: 1000 },
    },
  });
}

/**
 * A scheduler backed by BullMQ Job Schedulers.
 *
 * Job Schedulers, not the older repeatable-job API: a scheduler is addressed by
 * a **key we choose**, so using the monitor's id as that key makes every
 * operation naturally idempotent. Upserting the same monitor twice updates one
 * scheduler instead of producing two, and removal needs no bookkeeping to work
 * out which repeat key belonged to which monitor. The old API derived its key
 * from the repeat options, which meant changing an interval silently left the
 * previous schedule running — exactly the duplicate-execution bug this design
 * has to avoid.
 */
export class BullMqScheduler implements CheckScheduler {
  private readonly queue: Queue;

  constructor(queue: Queue) {
    this.queue = queue;
  }

  async sync(monitor: SchedulableMonitor): Promise<void> {
    if (!monitor.active) {
      await this.remove(monitor.id);
      return;
    }

    await upsert(this.queue, monitor);
  }

  async remove(monitorId: string): Promise<void> {
    // Returns false when there was nothing to remove, which is a normal
    // outcome (a paused monitor being paused again) and not an error.
    await this.queue.removeJobScheduler(monitorId);
  }
}

/** Create or update the scheduler for one active monitor. */
async function upsert(
  queue: Queue,
  monitor: SchedulableMonitor,
): Promise<void> {
  await queue.upsertJobScheduler(
    monitor.id,
    { every: monitor.intervalSeconds * 1000 },
    { name: CHECK_JOB_NAME, data: { monitorId: monitor.id } },
  );
}

/** What a reconciliation did, so the caller can log one honest line. */
export interface ReconcileReport {
  /** Active monitors that had no schedule, or the wrong interval. */
  added: number;
  /** Schedules with no active monitor behind them any more. */
  removed: number;
  /** Schedules already correct, and therefore left completely alone. */
  unchanged: number;
}

/**
 * Make the schedules in Redis match the monitors in PostgreSQL.
 *
 * Run at API startup, and the reason Redis can be treated as disposable. Redis
 * is the transport and the clock; PostgreSQL is the truth. Anything that
 * desynchronises the two — a flushed Redis, a monitor written while Redis was
 * unreachable, a delete whose scheduler removal failed — is repaired here
 * rather than needing an operator.
 *
 * The comparison is deliberate about what it does *not* touch. A schedule whose
 * interval already matches is left exactly as it is, because upserting it would
 * restart its timer: reconciling five hundred monitors on every deploy would
 * otherwise push every check up to one full interval into the future.
 */
export async function reconcileSchedules(
  db: pg.Pool,
  queue: Queue,
): Promise<ReconcileReport> {
  const { rows } = await db.query<{ id: string; interval_seconds: number }>(
    `SELECT id, interval_seconds FROM monitors WHERE active = true`,
  );

  const existing = new Map<string, number | undefined>(
    (await queue.getJobSchedulers(0, -1, true)).map((scheduler) => [
      scheduler.key,
      scheduler.every === undefined || scheduler.every === null
        ? undefined
        : Number(scheduler.every),
    ]),
  );

  const report: ReconcileReport = { added: 0, removed: 0, unchanged: 0 };

  for (const row of rows) {
    const wanted = row.interval_seconds * 1000;
    const current = existing.get(row.id);

    // Delete as we go, so whatever remains in the map is by definition an
    // orphan: a schedule for a monitor that is paused or no longer exists.
    existing.delete(row.id);

    if (current === wanted) {
      report.unchanged += 1;
      continue;
    }

    await upsert(queue, {
      id: row.id,
      intervalSeconds: row.interval_seconds,
      active: true,
    });
    report.added += 1;
  }

  for (const orphan of existing.keys()) {
    await queue.removeJobScheduler(orphan);
    report.removed += 1;
  }

  return report;
}
