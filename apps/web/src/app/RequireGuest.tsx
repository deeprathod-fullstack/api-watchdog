import { Navigate, Outlet, useSearchParams } from 'react-router-dom';

import { Loading } from '../components/states.js';
import { useAuth } from '../features/auth/useAuth.js';
import { safeReturnTo } from '../lib/return-to.js';

/**
 * The mirror of {@link RequireAuth} for /login and /register.
 *
 * It owns the post-sign-in redirect as well as keeping a signed-in user off
 * the credential screens — the same rule for both, so the forms never navigate
 * themselves and cannot race this. `returnTo` is validated as an internal path
 * before it is used; see `safeReturnTo`.
 */
export function RequireGuest() {
  const { status } = useAuth();
  const [searchParams] = useSearchParams();

  if (status === 'loading') {
    return <Loading label="Checking your session…" />;
  }

  if (status === 'authenticated') {
    return <Navigate to={safeReturnTo(searchParams.get('returnTo'))} replace />;
  }

  return <Outlet />;
}
