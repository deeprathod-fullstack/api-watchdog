/**
 * The single place that knows *where* the access token lives.
 *
 * V1 authenticates with a bearer JWT, so the token has to be readable by
 * JavaScript to be attached to a request — which means it is reachable by any
 * script that gets injected into the page. This is weaker than an HttpOnly
 * cookie and should not be described as equivalent; it matches the API
 * contract the backend actually offers today. Isolating it here means moving to
 * cookies later touches this file and the client, not every feature.
 *
 * `localStorage` throws in some privacy modes, so every access is guarded and a
 * failure degrades to "no session" rather than crashing the app.
 */
const STORAGE_KEY = 'api-watchdog.token';

export interface TokenStorage {
  get: () => string | null;
  set: (token: string) => void;
  clear: () => void;
}

export function createTokenStorage(
  storage: Storage | undefined = globalThis.localStorage,
): TokenStorage {
  return {
    get() {
      try {
        return storage?.getItem(STORAGE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    set(token) {
      try {
        storage?.setItem(STORAGE_KEY, token);
      } catch {
        // A session that cannot be persisted still works for this tab.
      }
    },
    clear() {
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // Nothing to do; the in-memory auth state is cleared regardless.
      }
    },
  };
}

/** In-memory storage, for tests and for browsers that block persistence. */
export function createMemoryTokenStorage(): TokenStorage {
  let token: string | null = null;
  return {
    get: () => token,
    set: (value) => {
      token = value;
    },
    clear: () => {
      token = null;
    },
  };
}
