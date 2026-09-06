/**
 * Where the tests' PostgreSQL lives.
 *
 * The suite runs against its own database on the same server as development,
 * never against the development database itself. That is not tidiness: some
 * assertions here are necessarily global — startup reconciliation compares
 * *every* active monitor against *every* job scheduler — and a global assertion
 * is only meaningful when the tests own everything the query can see. Sharing a
 * database with development made those tests fail whenever a developer had a
 * monitor of their own, which is data the suite has no business deleting.
 *
 * Derived from `DATABASE_URL` rather than configured separately, so there is
 * one credential and one host to get right, and a test run cannot be pointed
 * somewhere unexpected by a second variable nobody remembers to set.
 */

/** Suffix appended to the development database's name. */
const TEST_DATABASE_SUFFIX = '_test';

/**
 * The URL of the test database, and of the maintenance database used to create
 * it.
 *
 * `postgres` is the maintenance target because `CREATE DATABASE` cannot run
 * from inside the database being created.
 */
export interface TestDatabaseUrls {
  test: string;
  maintenance: string;
  name: string;
}

export function testDatabaseUrls(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): TestDatabaseUrls {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env before running tests.',
    );
  }

  const url = new URL(databaseUrl);
  // `pathname` is "/<database>"; an empty one means the URL names a server but
  // no database, which the application would reject too.
  const developmentName = url.pathname.replace(/^\//, '');

  if (!developmentName) {
    throw new Error(`DATABASE_URL names no database: ${url.host}`);
  }

  // Guard against the suffix being applied twice if DATABASE_URL already points
  // at a test database — running the suite against `api_watchdog_test_test`
  // would silently create a third, empty database.
  const name = developmentName.endsWith(TEST_DATABASE_SUFFIX)
    ? developmentName
    : `${developmentName}${TEST_DATABASE_SUFFIX}`;

  const test = new URL(url);
  test.pathname = `/${name}`;

  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';

  return { test: test.toString(), maintenance: maintenance.toString(), name };
}
