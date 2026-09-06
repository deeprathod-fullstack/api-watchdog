import { createContext } from 'react';

import type { LoginCredentials, RegisterCredentials, User } from './types.js';

/**
 * Three states, not a boolean.
 *
 * On a hard refresh the app holds a token but does not yet know whether it is
 * still valid, and that is neither "logged in" nor "logged out". Collapsing it
 * into a boolean is what produces the flash of the login page before a valid
 * session resolves, and route guards that redirect a signed-in user away.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  /** Set exactly when `status === 'authenticated'`. */
  user: User | null;
  login: (credentials: LoginCredentials) => Promise<User>;
  register: (credentials: RegisterCredentials) => Promise<User>;
  /**
   * V1 has no server-side revocation endpoint, so signing out means dropping
   * the token locally. The token stays valid until it expires; that is a real
   * limitation of bearer tokens without a denylist, not an oversight.
   */
  logout: () => void;
}

// Undefined default so `useAuth` can tell "no provider" from "not logged in".
export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
);
