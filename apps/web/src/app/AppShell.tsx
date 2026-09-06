import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';

import { Button } from '../components/Button.js';
import { useAuth } from '../features/auth/useAuth.js';
import { paths } from './paths.js';

/**
 * The chrome around every authenticated screen: brand, navigation, session
 * area, and the `<main>` the pages render into.
 */
export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleSignOut() {
    logout();
    // Clearing the session would send the guard to
    // `/login?returnTo=<here>`, which would bounce the user back into the app
    // on their next sign-in. A deliberate sign-out is not an interrupted
    // journey, so it goes to a plain login page.
    void navigate(paths.login, { replace: true });
  }

  return (
    <div className="shell">
      {/* First thing in the tab order: a keyboard user should not have to
          walk the whole header on every page to reach the content. */}
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="shell__header">
        <Link className="shell__brand" to={paths.dashboard}>
          {/* Drawn in CSS rather than shipped as an asset: two shapes that
              read as a status indicator, which is what the product is. */}
          <span className="shell__mark" aria-hidden="true" />
          API Watchdog
        </Link>

        <nav className="shell__nav" aria-label="Main">
          <NavLink className="shell__link" to={paths.dashboard} end>
            Dashboard
          </NavLink>
          <NavLink className="shell__link" to={paths.monitors}>
            Monitors
          </NavLink>
        </nav>

        <div className="shell__session">
          {user ? (
            <span className="shell__user">
              <span className="shell__user-name">{user.name}</span>
              <span className="shell__user-email">{user.email}</span>
            </span>
          ) : null}
          <Button variant="secondary" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="shell__main" id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
