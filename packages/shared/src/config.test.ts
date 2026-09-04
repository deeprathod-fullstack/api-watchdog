import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

/** The variables with no default, which every valid environment must supply. */
const required = {
  DATABASE_URL: 'postgresql://watchdog:secret@postgres:5432/api_watchdog',
};

describe('loadConfig', () => {
  it('applies defaults when optional variables are absent', () => {
    const config = loadConfig({ ...required });

    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: required.DATABASE_URL,
      DATABASE_POOL_MAX: 10,
    });
  });

  it('coerces numeric variables from the strings the environment provides', () => {
    const config = loadConfig({
      ...required,
      PORT: '8080',
      DATABASE_POOL_MAX: '25',
    });

    expect(config.PORT).toBe(8080);
    expect(config.DATABASE_POOL_MAX).toBe(25);
  });

  it('rejects a malformed value instead of starting with bad config', () => {
    expect(() => loadConfig({ ...required, PORT: 'not-a-port' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...required, NODE_ENV: 'staging' })).toThrow(
      ConfigError,
    );
  });

  it('refuses to start without a database URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('rejects a database URL that is not a postgres URL', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'mysql://user:pw@host:3306/db' }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'not a url' })).toThrow(
      ConfigError,
    );
  });

  it('ignores unrelated environment variables', () => {
    const config = loadConfig({ ...required, SOME_UNRELATED_VAR: 'x' });

    expect(config).not.toHaveProperty('SOME_UNRELATED_VAR');
  });
});
