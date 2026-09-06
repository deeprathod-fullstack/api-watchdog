import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '../features/auth/AuthProvider.js';
import { AppRoutes } from './AppRoutes.js';
import { ErrorBoundary } from './ErrorBoundary.js';

/**
 * Composition root: error boundary, session, router. The router sits inside
 * the provider so route guards can read the session.
 */
export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
