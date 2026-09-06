import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '../features/auth/useAuth.js';
import { Loading } from '../components/states.js';
import { paths } from './paths.js';

/**
 * The mirror of {@link RequireAuth} for /login and /register.
 *
 * Without it a signed-in user can sit on the login form, and a successful
 * login redirect can bounce back into it. The two guards only ever redirect
 * from a settled state, which is what keeps them from looping.
 */
export function RequireGuest() {
  const { status } = useAuth();

  if (status === 'loading') {
    return <Loading label="Checking your session…" />;
  }

  if (status === 'authenticated') {
    return <Navigate to={paths.dashboard} replace />;
  }

  return <Outlet />;
}
