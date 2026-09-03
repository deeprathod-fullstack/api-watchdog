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
