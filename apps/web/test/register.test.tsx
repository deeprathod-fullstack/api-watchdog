import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { USER, errorResponse, jsonResponse, renderApp } from './helpers.js';

const PASSWORD = 'correct horse battery';

function fillIn(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
}

function fillForm(overrides: Partial<Record<string, string>> = {}) {
  fillIn(/name/i, overrides.name ?? USER.name);
  fillIn(/email/i, overrides.email ?? USER.email);
  fillIn(/^password$/i, overrides.password ?? PASSWORD);
  fillIn(/confirm password/i, overrides.confirmPassword ?? PASSWORD);
}

describe('register', () => {
  it('renders the form with the expected fields and a link to sign in', async () => {
    renderApp({ path: '/register' });

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Create an account',
      }),
    ).toBeTruthy();

    expect(screen.getByLabelText(/name/i).getAttribute('autocomplete')).toBe(
      'name',
    );
    expect(screen.getByLabelText(/email/i).getAttribute('autocomplete')).toBe(
      'email',
    );
    expect(
      screen.getByLabelText(/^password$/i).getAttribute('autocomplete'),
    ).toBe('new-password');
    expect(
      screen.getByLabelText(/confirm password/i).getAttribute('autocomplete'),
    ).toBe('new-password');
    expect(screen.getByRole('link', { name: /sign in/i })).toBeTruthy();
  });

  it('requires every field before calling the API', async () => {
    const { fetchImpl } = renderApp({ path: '/register' });

    await screen.findByRole('heading', { name: 'Create an account' });
    submit();

    expect(await screen.findByText('Name is required.')).toBeTruthy();
    expect(screen.getByText('Email is required.')).toBeTruthy();
    expect(screen.getByText('Password is required.')).toBeTruthy();
    expect(screen.getByText('Confirm your password.')).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the backend password minimum before spending a request', async () => {
    const { fetchImpl } = renderApp({ path: '/register' });

    await screen.findByRole('heading', { name: 'Create an account' });
    fillForm({ password: 'short', confirmPassword: 'short' });
    submit();

    expect(
      await screen.findByText('Password must be at least 12 characters.'),
    ).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('catches a mistyped confirmation', async () => {
    const { fetchImpl } = renderApp({ path: '/register' });

    await screen.findByRole('heading', { name: 'Create an account' });
    fillForm({ confirmPassword: 'correct horse batteryy' });
    submit();

    expect(await screen.findByText('Passwords do not match.')).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('registers, stores the token, and never sends the confirmation', async () => {
    const { storage, getRequests } = renderApp({
      path: '/register',
      responses: [jsonResponse(201, { user: USER, token: 'token-new' })],
    });

    await screen.findByRole('heading', { name: 'Create an account' });
    fillForm();
    submit();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard' }),
    ).toBeTruthy();
    expect(storage.get()).toBe('token-new');

    const [request] = getRequests();
    expect(request?.url).toBe('/api/auth/register');
    expect(request?.body).toEqual({
      name: USER.name,
      email: USER.email,
      password: PASSWORD,
    });
    expect(request?.body).not.toHaveProperty('confirmPassword');
  });

  it('trims a name before sending it', async () => {
    const { getRequests } = renderApp({
      path: '/register',
      responses: [jsonResponse(201, { user: USER, token: 'token-new' })],
    });

    await screen.findByRole('heading', { name: 'Create an account' });
    fillForm({ name: '  Deep Rathod  ' });
    submit();

    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    expect(getRequests()[0]?.body).toMatchObject({ name: 'Deep Rathod' });
  });

  it('explains a duplicate email without exposing the backend message', async () => {
    const { storage } = renderApp({
      path: '/register',
      responses: [
        errorResponse(409, 'email_taken', 'Email is already registered'),
      ],
    });

    await screen.findByRole('heading', { name: 'Create an account' });
    fillForm();
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'An account with this email already exists.',
    );
    expect(storage.get()).toBeNull();
    // Still on the form, with the password fields cleared.
    expect(screen.getByLabelText(/^password$/i)).toHaveProperty('value', '');
    expect(screen.getByLabelText(/confirm password/i)).toHaveProperty(
      'value',
      '',
    );
  });

  it('reports an unreachable API in plain language', async () => {
    renderApp({
      path: '/register',
      responses: [new TypeError('Failed to fetch')],
    });

    await screen.findByRole('heading', { name: 'Create an account' });
    fillForm();
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Unable to reach API Watchdog. Please try again.',
    );
  });
});
