import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { loadDotenv } from '@api-watchdog/shared';

import { testDatabaseUrls } from './database-url.js';

/**
 * Create the test database and bring it up to the current schema, once, before
 * any test file runs.
 *
 * Running migrations here rather than expecting a developer to have run them is
 * what makes a fresh checkout work: `npm test` is the only command anyone has
 * to remember, and a migration added on a branch cannot leave the suite
 * silently testing an old schema.
 *
 * The database is created if absent and then left in place between runs.
 * Dropping and recreating it every time would cost a second or two per run and
 * buy nothing — the schema is migrated to the same point either way, and each
 * test file already removes the rows it created.
 */
export default async function setup(): Promise<void> {
  loadDotenv();

  const urls = testDatabaseUrls();

  await createDatabaseIfMissing(urls.maintenance, urls.name);

  await runner({
    databaseUrl: urls.test,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    // Quiet unless something goes wrong: a clean run should not print four
    // migration lines above every test report.
    log: () => undefined,
  });
}

/**
 * `CREATE DATABASE` has no `IF NOT EXISTS`, so existence is checked first.
 *
 * The name is not interpolated from user input — it comes from DATABASE_URL
 * with a fixed suffix — but it still cannot be a bound parameter, because
 * PostgreSQL does not allow parameters in DDL. It is quoted as an identifier
 * instead of concatenated raw.
 */
async function createDatabaseIfMissing(
  maintenanceUrl: string,
  name: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: maintenanceUrl });
  await client.connect();

  try {
    const { rowCount } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );

    if (rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    }
  } finally {
    await client.end();
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
