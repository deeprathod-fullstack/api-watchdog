import { describe, expect, it, vi } from 'vitest';

import { testDatabaseUrls } from './database-url.js';

/**
 * The derivation that keeps the suite off the development database.
 *
 * Worth testing on its own because everything else depends on it silently: if
 * this returned the development URL, every test would still pass while quietly
 * reading and deleting a developer's data.
 */
describe('test database URL', () => {
  const development = 'postgresql://watchdog:pw@localhost:5432/api_watchdog';

  it('points at a sibling database, never the development one', () => {
    const urls = testDatabaseUrls(development);

    expect(urls.name).toBe('api_watchdog_test');
    expect(urls.test).toBe(
      'postgresql://watchdog:pw@localhost:5432/api_watchdog_test',
    );
    expect(urls.test).not.toBe(development);
  });

  it('keeps the server, port and credentials of the development URL', () => {
    const urls = testDatabaseUrls(
      'postgresql://someone:secret@db.internal:6543/watchdog',
    );
    const url = new URL(urls.test);

    expect(url.host).toBe('db.internal:6543');
    expect(url.username).toBe('someone');
    expect(url.password).toBe('secret');
    expect(url.pathname).toBe('/watchdog_test');
  });

  it('creates the database from the maintenance connection', () => {
    // CREATE DATABASE cannot run from inside the database being created.
    const urls = testDatabaseUrls(development);

    expect(new URL(urls.maintenance).pathname).toBe('/postgres');
    expect(new URL(urls.maintenance).host).toBe('localhost:5432');
  });

  it('does not append the suffix twice', () => {
    // Someone whose DATABASE_URL already points at a test database should get
    // that database, not a third, empty `_test_test` one.
    const urls = testDatabaseUrls(
      'postgresql://watchdog:pw@localhost:5432/api_watchdog_test',
    );

    expect(urls.name).toBe('api_watchdog_test');
  });

  it('fails loudly when DATABASE_URL is not set', () => {
    // Exercised through the default parameter, which is the path a developer
    // with no .env actually takes.
    vi.stubEnv('DATABASE_URL', '');

    expect(() => testDatabaseUrls()).toThrow(/DATABASE_URL is not set/);

    vi.unstubAllEnvs();
  });

  it('fails loudly when the URL names no database', () => {
    // Better to stop than to connect to whatever database the server hands
    // back by default.
    expect(() =>
      testDatabaseUrls('postgresql://watchdog:pw@localhost:5432'),
    ).toThrow(/names no database/);
  });
});
