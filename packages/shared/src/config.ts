import { z } from 'zod';

/**
 * Every environment variable the system reads is declared here.
 *
 * Nothing else in the codebase should touch `process.env`: a single validated,
 * typed entry point means a misconfigured deployment fails at startup with a
 * clear message instead of throwing a confusing error later under load.
 */
export const configSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Full PostgreSQL connection string, e.g.
   * `postgresql://user:password@host:5432/database`.
   *
   * A single URL rather than five separate variables: it is the format every
   * managed provider hands out (RDS, Heroku, Neon), so deployment means
   * pasting one secret instead of decomposing and reassembling it.
   */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          const { protocol } = new URL(value);
          return protocol === 'postgres:' || protocol === 'postgresql:';
        } catch {
          return false;
        }
      },
      { message: 'must be a postgres:// or postgresql:// URL' },
    ),

  /**
   * Maximum connections this process keeps open to PostgreSQL.
   *
   * Every process (api, worker) holds its own pool, and PostgreSQL enforces a
   * server-wide `max_connections`. Sizing this per process is how we avoid a
   * scaled-out deployment exhausting the database.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * Signing key for API access tokens (HS256).
   *
   * Validated here, so a deployment with a missing or weak secret fails at
   * startup rather than at the first login attempt. HS256 security is exactly
   * the entropy of this string: a short secret is brute-forceable offline from
   * a single captured token, and anyone who recovers it can mint a token for
   * any user id. 32 characters is the floor, not a target — generate it with
   * `openssl rand -base64 48`, never by hand.
   */
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
});

export type Config = Readonly<z.infer<typeof configSchema>>;

/** Thrown when the environment does not satisfy {@link configSchema}. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validate an environment and return typed, frozen configuration.
 *
 * @param env - the environment to read; injectable so tests need no globals.
 * @throws {ConfigError} if any variable is missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }

  return Object.freeze(result.data);
}
