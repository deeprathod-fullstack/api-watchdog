import { useContext } from 'react';

import { AuthContext, type AuthContextValue } from './auth-context.js';

/** Read the session. Throws if used outside {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return value;
}
