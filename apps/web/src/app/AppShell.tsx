import { Link, NavLink, Outlet } from 'react-router-dom';

import { Button } from '../components/Button.js';
import { useAuth } from '../features/auth/useAuth.js';
import { paths } from './paths.js';

/**
 * The chrome around every authenticated screen: brand, navigation, session
 * area, and the `<main>` the pages render into.
 */
export function AppShell() {
  const { user, logout } = useAuth();

  return (
    <div className="shell">
      <header className="shell__header">
        <Link className="shell__brand" to={paths.dashboard}>
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
          {user ? <span className="shell__user">{user.email}</span> : null}
          <Button variant="secondary" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="shell__main" id="main">
        <Outlet />
      </main>
    </div>
  );
}
