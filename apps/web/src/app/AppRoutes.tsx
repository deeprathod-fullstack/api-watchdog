import { Route, Routes } from 'react-router-dom';

import { DashboardPage } from '../routes/DashboardPage.js';
import { LoginPage } from '../routes/LoginPage.js';
import { MonitorDetailPage } from '../routes/MonitorDetailPage.js';
import { MonitorHistoryPage } from '../routes/MonitorHistoryPage.js';
import { MonitorsPage } from '../routes/MonitorsPage.js';
import { NotFoundPage } from '../routes/NotFoundPage.js';
import { RegisterPage } from '../routes/RegisterPage.js';
import { AppShell } from './AppShell.js';
import { RequireAuth } from './RequireAuth.js';
import { RequireGuest } from './RequireGuest.js';
import { paths } from './paths.js';

/**
 * The route table.
 *
 * The public and authenticated areas are separated by layout routes, not by
 * per-page checks: `RequireGuest` fronts the credential screens, `RequireAuth`
 * plus `AppShell` front everything else. Adding a protected screen is one
 * `<Route>` inside the guarded block and nothing more.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<RequireGuest />}>
        <Route path={paths.login} element={<LoginPage />} />
        <Route path={paths.register} element={<RegisterPage />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path={paths.dashboard} element={<DashboardPage />} />
          <Route path={paths.monitors} element={<MonitorsPage />} />
          <Route path="/monitors/:id" element={<MonitorDetailPage />} />
          <Route
            path="/monitors/:id/history"
            element={<MonitorHistoryPage />}
          />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
