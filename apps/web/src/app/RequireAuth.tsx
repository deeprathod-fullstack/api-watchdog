import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../features/auth/useAuth.js';
import { Loading } from '../components/states.js';
import { paths } from './paths.js';

/**
 * The single gate in front of every authenticated route.
 *
 * Used as a layout route, so pages below it can assume a session exists and
 * none of them repeats an auth check. While the session is still resolving it
 * renders a loading state rather than redirecting — redirecting on "unknown"
 * is what bounces a signed-in user to the login page on every refresh.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <Loading label="Checking your session…" />;
  }

  if (status === 'unauthenticated') {
    // Remember where they were headed so the login screen can return them.
    return <Navigate to={paths.login} replace state={{ from: location }} />;
  }

  return <Outlet />;
}
