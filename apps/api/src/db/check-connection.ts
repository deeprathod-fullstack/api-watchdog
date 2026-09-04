/**
 * One-shot database connectivity check: `npm run db:check`.
 *
 * Deliberately a script rather than part of the test suite — the test suite
 * must stay runnable in CI without a database, while this exists to answer
 * "is my local Docker PostgreSQL reachable with these credentials?".
 */
import { loadConfig, loadDotenv } from '@api-watchdog/shared';

import { closePool, getPool } from './pool.js';

loadDotenv();

const config = loadConfig();
const pool = getPool(config);

// `pool.connect()` (rather than `pool.query()`) so the acquire/release cycle
// itself is exercised — that is the part that leaks connections when done
// wrong.
const client = await pool.connect();

try {
  const result = await client.query<{ version: string; database: string }>(
    'SELECT version() AS version, current_database() AS database',
  );
  const row = result.rows[0];

  console.log(`Connected to database: ${row?.database}`);
  console.log(row?.version);
} finally {
  // `finally`, not a trailing call: a failed query must still hand the
  // connection back, or the pool bleeds one connection per failure until it is
  // empty and every request hangs.
  client.release();
  await closePool();
}
