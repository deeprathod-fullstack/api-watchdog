import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { DashboardPage } from '../routes/DashboardPage.js';
import { LoginPage } from '../routes/LoginPage.js';
import { MonitorHistoryPage } from '../routes/MonitorHistoryPage.js';
import { MonitorsPage } from '../routes/MonitorsPage.js';
import { NewMonitorPage } from '../routes/NewMonitorPage.js';
import { EditMonitorPage } from '../routes/EditMonitorPage.js';
import { NotFoundPage } from '../routes/NotFoundPage.js';
import { RegisterPage } from '../routes/RegisterPage.js';
import { AppShell } from './AppShell.js';
import { RequireAuth } from './RequireAuth.js';
import { RequireGuest } from './RequireGuest.js';
import { paths } from './paths.js';

/** Sends `/monitors/:id` to that monitor's history. */
function MonitorDetailRedirect() {
  const { id = '' } = useParams<{ id: string }>();

  return <Navigate to={paths.monitorHistory(id)} replace />;
}

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
          {/* Static before dynamic is only for readability — the router ranks
              `/monitors/new` above `/monitors/:id` regardless of order. */}
          <Route path={paths.monitorNew} element={<NewMonitorPage />} />
          <Route path="/monitors/:id/edit" element={<EditMonitorPage />} />
          {/* There is no separate detail screen in V1; history is what a
              monitor's own page shows. Redirecting rather than 404ing keeps
              any bookmarked or shared link working. */}
          <Route path="/monitors/:id" element={<MonitorDetailRedirect />} />
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
