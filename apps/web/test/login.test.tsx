import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  USER,
  dashboardResponse,
  errorResponse,
  jsonResponse,
  renderApp,
} from './helpers.js';

function fillIn(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

const CREDENTIALS = { email: USER.email, password: 'correct horse battery' };

function fillCredentials() {
  fillIn(/email/i, CREDENTIALS.email);
  fillIn(/password/i, CREDENTIALS.password);
}

describe('login', () => {
  it('renders the form with the expected fields and a link to register', async () => {
    renderApp({ path: '/login' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeTruthy();
    const email = screen.getByLabelText(/email/i);
    const password = screen.getByLabelText(/password/i);

    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(password.getAttribute('type')).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByRole('link', { name: /create one/i })).toBeTruthy();
  });

  it('does not call the API when the form is empty', async () => {
    const { fetchImpl } = renderApp({ path: '/login' });

    await screen.findByRole('heading', { name: 'Sign in' });
    submit();

    expect(await screen.findByText('Email is required.')).toBeTruthy();
    expect(screen.getByText('Password is required.')).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not call the API when the email is malformed', async () => {
    const { fetchImpl } = renderApp({ path: '/login' });

    await screen.findByRole('heading', { name: 'Sign in' });
    fillIn(/email/i, 'not-an-email');
    fillIn(/password/i, 'correct horse battery');
    submit();

    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('signs in, stores the token and lands on the dashboard', async () => {
    const { storage, getRequests } = renderApp({
      path: '/login',
      responses: [
        jsonResponse(200, { user: USER, token: 'token-abc' }),
        // Landing on the dashboard issues its own request.
        dashboardResponse(),
      ],
    });

    await screen.findByRole('heading', { name: 'Sign in' });
    fillCredentials();
    submit();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard' }),
    ).toBeTruthy();
    expect(storage.get()).toBe('token-abc');

    // The session is reflected in the shell, from the one auth state.
    expect(screen.getByText(USER.name)).toBeTruthy();
    expect(screen.getByText(USER.email)).toBeTruthy();

    const [request] = getRequests();
    expect(request?.url).toBe('/api/auth/login');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual(CREDENTIALS);
    // A sign-in is not an authenticated request.
    expect(request?.headers.get('Authorization')).toBeNull();
  });

  it('shows one generic message for invalid credentials', async () => {
    renderApp({
      path: '/login',
      responses: [
        errorResponse(401, 'invalid_credentials', 'Invalid email or password'),
      ],
    });

    await screen.findByRole('heading', { name: 'Sign in' });
    fillCredentials();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Invalid email or password.');

    // The email survives so it need not be retyped; the password does not.
    expect(screen.getByLabelText(/email/i)).toHaveProperty(
      'value',
      CREDENTIALS.email,
    );
    expect(screen.getByLabelText(/password/i)).toHaveProperty('value', '');
  });

  it('explains a rate limit rather than showing a generic failure', async () => {
    renderApp({
      path: '/login',
      responses: [
        errorResponse(
          429,
          'rate_limited',
          'Too many requests, try again later',
        ),
      ],
    });

    await screen.findByRole('heading', { name: 'Sign in' });
    fillCredentials();
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many attempts. Please try again later.',
    );
  });

  it('reports an unreachable API in plain language', async () => {
    renderApp({
      path: '/login',
      responses: [new TypeError('Failed to fetch')],
    });

    await screen.findByRole('heading', { name: 'Sign in' });
    fillCredentials();
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Unable to reach API Watchdog. Please try again.',
    );
  });

  it('never shows a server-side 500 message', async () => {
    renderApp({
      path: '/login',
      responses: [
        errorResponse(500, 'internal_error', 'ECONNREFUSED 10.0.0.4:5432'),
      ],
    });

    await screen.findByRole('heading', { name: 'Sign in' });
    fillCredentials();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    expect(alert.textContent).not.toContain('10.0.0.4');
  });

  it('refuses a second submission while one is in flight', async () => {
    const { fetchImpl } = renderApp({
      path: '/login',
      // One login response; a second login attempt would starve the queue.
      responses: [
        jsonResponse(200, { user: USER, token: 'token-abc' }),
        dashboardResponse(),
      ],
    });

    await screen.findByRole('heading', { name: 'Sign in' });
    fillCredentials();

    const button = screen.getByRole('button', { name: /sign in/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await waitFor(() => {
      // One login, one dashboard load — not three logins.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
