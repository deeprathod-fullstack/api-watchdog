import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AppRoutes } from '../src/app/AppRoutes.js';
import { AuthProvider } from '../src/features/auth/AuthProvider.js';
import { createApiClient } from '../src/lib/api-client.js';
import { createMemoryTokenStorage } from '../src/lib/token-storage.js';

const USER = {
  id: 'u1',
  name: 'Deep',
  email: 'deep@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Render the real route table under a real provider, with only the network and
 * the token store faked. That is what makes these tests about the guards
 * rather than about mocks of the guards.
 */
function renderApp({
  token,
  meResponse = jsonResponse(200, { user: USER }),
  path = '/',
}: {
  token?: string;
  meResponse?: Response;
  path?: string;
}) {
  const storage = createMemoryTokenStorage();
  if (token) storage.set(token);

  const fetchImpl = vi.fn().mockResolvedValue(meResponse);
  const client = createApiClient({ fetchImpl, getToken: () => storage.get() });

  render(
    <AuthProvider client={client} storage={storage}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );

  return { storage, fetchImpl };
}

describe('route protection', () => {
  it('shows a loading state while the session is still unknown', () => {
    renderApp({ token: 'token-abc' });

    expect(screen.getByRole('status').textContent).toContain(
      'Checking your session',
    );
  });

  it('renders a protected route once the session resolves', async () => {
    const { fetchImpl } = renderApp({ token: 'token-abc' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard' }),
    ).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();

    // The bootstrap request carried the stored token.
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer token-abc',
    );
  });

  it('redirects to /login when there is no token, without calling the API', async () => {
    const { fetchImpl } = renderApp({ path: '/monitors' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redirects and discards the token when the API rejects it', async () => {
    const { storage } = renderApp({
      token: 'expired',
      meResponse: jsonResponse(401, {
        error: { code: 'unauthenticated', message: 'Authentication required' },
      }),
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(storage.get()).toBeNull();
    });
  });

  it('keeps a token that failed only because the network did', async () => {
    const storage = createMemoryTokenStorage();
    storage.set('token-abc');
    const client = createApiClient({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      getToken: () => storage.get(),
    });

    render(
      <AuthProvider client={client} storage={storage}>
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeTruthy();
    expect(storage.get()).toBe('token-abc');
  });

  it('lets a signed-out visitor reach the public routes', async () => {
    renderApp({ path: '/register' });

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Create an account',
      }),
    ).toBeTruthy();
  });

  it('sends a signed-in user away from the credential screens', async () => {
    renderApp({ token: 'token-abc', path: '/login' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard' }),
    ).toBeTruthy();
  });

  it('renders a not-found page for an unknown path', async () => {
    renderApp({ path: '/nope' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeTruthy();
  });
});
