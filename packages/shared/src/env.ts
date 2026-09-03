import { config as readDotenvFile } from 'dotenv';

/**
 * Load a local `.env` file into `process.env` for development convenience.
 *
 * Call this once from a process entry point, never from library code, so that
 * importing a module never has hidden side effects.
 *
 * Existing environment variables are not overwritten, so values injected by
 * Docker, CI, or AWS always take precedence over a local `.env`.
 */
export function loadDotenv(): void {
  readDotenvFile({ quiet: true });
}
