import { createApiClient } from './api-client.js';
import { createTokenStorage } from './token-storage.js';

/**
 * The application's wiring of the two pieces above.
 *
 * Feature modules import `api` and stay ignorant of where the token lives; the
 * auth provider imports `tokenStorage` and is the only thing that writes it.
 * Tests build their own client instead of importing these.
 */
export const tokenStorage = createTokenStorage();

/**
 * Where a rejected token is reported.
 *
 * The client cannot clear React state and the provider cannot see every
 * request, so they meet here: the provider subscribes on mount, the client
 * publishes when an authenticated call comes back 401. A single slot rather
 * than a list of listeners, because there is exactly one session.
 */
let sessionExpiredHandler: (() => void) | null = null;

export function onSessionExpired(handler: () => void): () => void {
  sessionExpiredHandler = handler;

  return () => {
    if (sessionExpiredHandler === handler) {
      sessionExpiredHandler = null;
    }
  };
}

export const api = createApiClient({
  getToken: () => tokenStorage.get(),
  onUnauthenticated: () => {
    sessionExpiredHandler?.();
  },
});
