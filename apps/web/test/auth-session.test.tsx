import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../src/features/auth/AuthProvider.js';
import { useAuth } from '../src/features/auth/useAuth.js';
import { createApiClient } from '../src/lib/api-client.js';
import { createMemoryTokenStorage } from '../src/lib/token-storage.js';

const USER = {
  id: 'u1',
  name: 'Deep',
  email: 'deep@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Exposes the auth primitives so the test can drive them directly. */
function Probe() {
  const { status, user, login, logout } = useAuth();

  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>
      <button
        type="button"
        onClick={() => {
          void login({ email: USER.email, password: 'correct horse' });
        }}
      >
        sign in
      </button>
      <button type="button" onClick={logout}>
        sign out
      </button>
    </div>
  );
}

describe('auth session', () => {
  it('settles on unauthenticated with no stored token and makes no request', async () => {
    const fetchImpl = vi.fn();
    render(
      <AuthProvider
        client={createApiClient({ fetchImpl })}
        storage={createMemoryTokenStorage()}
      >
        <Probe />
      </AuthProvider>,
    );

    expect(await screen.findByText('unauthenticated')).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stores the token on login and clears it on logout', async () => {
    const storage = createMemoryTokenStorage();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: USER, token: 'token-abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(
      <AuthProvider
        client={createApiClient({ fetchImpl, getToken: () => storage.get() })}
        storage={storage}
      >
        <Probe />
      </AuthProvider>,
    );

    await screen.findByText('unauthenticated');

    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));

    expect(await screen.findByText('authenticated')).toBeTruthy();
    expect(screen.getByTestId('user').textContent).toBe(USER.email);
    expect(storage.get()).toBe('token-abc');

    // The credentials must never be echoed back into the URL or the headers.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(await screen.findByText('unauthenticated')).toBeTruthy();
    expect(storage.get()).toBeNull();
  });
});
