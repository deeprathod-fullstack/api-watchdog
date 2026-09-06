import { Redis } from 'ioredis';

import type { Config } from '@api-watchdog/shared';

/**
 * A Redis connection for BullMQ.
 *
 * Built here rather than by handing BullMQ a URL, because BullMQ needs specific
 * client settings and getting them wrong produces failures that look like
 * application bugs:
 *
 * - `maxRetriesPerRequest: null` is required by BullMQ. A worker blocks on
 *   `BRPOPLPUSH` for as long as the queue is empty, and ioredis's default retry
 *   ceiling would treat that perfectly healthy wait as a failed command and
 *   tear the connection down.
 * - `enableReadyCheck: false` keeps a brief `LOADING` state during a Redis
 *   restart from being fatal; the client retries instead of throwing.
 *
 * Each process owns its connections and closes them on shutdown. Nothing here
 * is a singleton, so tests can build a connection, use it, and dispose of it.
 */
export function createRedisConnection(config: Config): Redis {
  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  // Without a listener, ioredis emits a connection failure as an unhandled
  // 'error' event, which takes the process down. Redis being briefly
  // unreachable must not kill the API: it reconnects on its own, and the
  // schedules are rebuilt from PostgreSQL at startup regardless.
  connection.on('error', (error: Error) => {
    console.error('Redis connection error:', error.message);
  });

  return connection;
}
