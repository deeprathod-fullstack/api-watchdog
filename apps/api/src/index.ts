import { createServer } from 'node:http';

import { loadConfig, loadDotenv } from '@api-watchdog/shared';

import { createApp } from './app.js';

/** Grace period for in-flight requests before the process is forced down. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

loadDotenv();

// Fail fast: a misconfigured process should never reach the point of accepting
// traffic, so that a bad deploy is reported as failed rather than serving 500s.
const config = loadConfig();

const server = createServer(createApp());

server.listen(config.PORT, () => {
  console.log(`api listening on port ${config.PORT} (env: ${config.NODE_ENV})`);
});

/**
 * Shut down cleanly on SIGTERM/SIGINT.
 *
 * Every deployment — Docker restart, CI redeploy, AWS instance replacement —
 * sends SIGTERM. Without this, the process dies mid-request. With it, we stop
 * accepting connections, drain in-flight work, then exit.
 */
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // Do not keep the event loop alive purely for the timeout.
  forceExit.unref();

  server.close((err) => {
    clearTimeout(forceExit);
    if (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
    console.log('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
