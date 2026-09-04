import pg from 'pg';

import { type Config } from '@api-watchdog/shared';

/**
 * The process-wide connection pool.
 *
 * A `Pool` is not a connection: it opens up to `max` real connections lazily
 * and lends them out. Connecting to PostgreSQL costs a TCP handshake plus
 * authentication, so a long-running server must reuse connections rather than
 * open one per request — and PostgreSQL enforces a server-wide
 * `max_connections` that per-request connecting would exhaust.
 */
let pool: pg.Pool | undefined;

/**
 * Get the pool, creating it on first call.
 *
 * Lazy rather than created at import time so that importing this module has no
 * side effects: tests and scripts can import it without opening sockets.
 */
export function getPool(config: Config): pg.Pool {
  pool ??= createPool(config);
  return pool;
}

/** Build a pool. Exported for tests that want an isolated, disposable pool. */
export function createPool(config: Config): pg.Pool {
  const instance = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,

    // Bound every phase, so a network black hole cannot pin a request forever.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  // An idle connection can be dropped by PostgreSQL, a proxy, or a NAT
  // timeout. Without a listener, node-pg emits that as an unhandled 'error'
  // event and takes the whole process down. The pool discards the broken
  // connection by itself; we only need to make sure it is not fatal.
  instance.on('error', (error) => {
    console.error('Unexpected error on idle PostgreSQL client:', error);
  });

  return instance;
}

/**
 * Close the pool during shutdown.
 *
 * Without this the process keeps open sockets and will not exit on SIGTERM
 * until something forces it.
 */
export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
