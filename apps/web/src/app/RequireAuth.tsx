import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { Loading } from '../components/states.js';
import { useAuth } from '../features/auth/useAuth.js';
import { loginPathWithReturnTo } from '../lib/return-to.js';
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
    // Carry the intended destination so signing in resumes it instead of
    // dumping everyone on the dashboard. It travels in the URL rather than in
    // router state so that it survives a reload of the login page.
    const destination = `${location.pathname}${location.search}`;

    return (
      <Navigate to={loginPathWithReturnTo(paths.login, destination)} replace />
    );
  }

  return <Outlet />;
}
