import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  api as defaultApi,
  onSessionExpired as defaultOnSessionExpired,
  tokenStorage as defaultStorage,
} from '../../lib/api.js';
import type { ApiClient } from '../../lib/api-client.js';
import { ApiError } from '../../lib/api-error.js';
import type { TokenStorage } from '../../lib/token-storage.js';
import * as authApi from './auth-api.js';
import { AuthContext, type AuthStatus } from './auth-context.js';
import type { LoginCredentials, RegisterCredentials, User } from './types.js';

export interface AuthProviderProps {
  children: ReactNode;
  /** Overridable so tests drive the provider without a network or storage. */
  client?: ApiClient;
  storage?: TokenStorage;
  /**
   * Subscription to "a request just came back 401". Injected alongside the
   * client so a test can wire its own pair.
   */
  onSessionExpired?: (handler: () => void) => () => void;
}

/**
 * Owns the session for the whole application.
 *
 * Every screen reads the session from here, so no page performs its own auth
 * check and there is exactly one bootstrap request per page load.
 */
export function AuthProvider({
  children,
  client = defaultApi,
  storage = defaultStorage,
  onSessionExpired = defaultOnSessionExpired,
}: AuthProviderProps) {
  // No stored token is already a settled answer, so it is read here rather
  // than in the effect below: starting at 'loading' and immediately setting
  // 'unauthenticated' would only buy an extra render pass.
  const [status, setStatus] = useState<AuthStatus>(() =>
    storage.get() ? 'loading' : 'unauthenticated',
  );
  const [user, setUser] = useState<User | null>(null);

  // Session bootstrap: a stored token is only a claim, so it is exchanged for
  // the real user before any protected screen renders.
  useEffect(() => {
    if (!storage.get()) return;

    const controller = new AbortController();

    authApi
      .fetchCurrentUser(client, { signal: controller.signal })
      .then((result) => {
        setUser(result.user);
        setStatus('authenticated');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;

        // A rejected token is worthless; drop it so the next load skips this
        // round trip. A network failure is *not* proof the token is bad, but
        // the app still cannot run authenticated, so it lands on the login
        // page with the token intact for the next attempt.
        if (error instanceof ApiError && error.isUnauthenticated) {
          storage.clear();
        }
        setUser(null);
        setStatus('unauthenticated');
      });

    return () => {
      controller.abort();
    };
  }, [client, storage]);

  const adopt = useCallback(
    (result: { user: User; token: string }) => {
      storage.set(result.token);
      setUser(result.user);
      setStatus('authenticated');
      return result.user;
    },
    [storage],
  );

  const login = useCallback(
    async (credentials: LoginCredentials) =>
      adopt(await authApi.login(client, credentials)),
    [adopt, client],
  );

  const register = useCallback(
    async (credentials: RegisterCredentials) =>
      adopt(await authApi.register(client, credentials)),
    [adopt, client],
  );

  const logout = useCallback(() => {
    storage.clear();
    setUser(null);
    setStatus('unauthenticated');
  }, [storage]);

  // A token can expire mid-session, and the first thing that notices is
  // whichever request happens to be in flight. Ending the session centrally
  // means no screen has to handle a 401 itself, and the route guard performs
  // the redirect exactly as it does for any other signed-out visitor — no
  // second redirect path to keep in step, and no loop.
  useEffect(() => onSessionExpired(logout), [onSessionExpired, logout]);

  const value = useMemo(
    () => ({ status, user, login, register, logout }),
    [status, user, login, register, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
