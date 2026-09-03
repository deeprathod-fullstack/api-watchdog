import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults when optional variables are absent', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });

  it('coerces PORT from the string the environment always provides', () => {
    const config = loadConfig({ PORT: '8080' });

    expect(config.PORT).toBe(8080);
  });

  it('rejects a malformed value instead of starting with bad config', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(ConfigError);
  });

  it('ignores unrelated environment variables', () => {
    const config = loadConfig({ SOME_UNRELATED_VAR: 'x' });

    expect(config).not.toHaveProperty('SOME_UNRELATED_VAR');
  });
});
