import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  USER,
  errorResponse,
  jsonResponse,
  monitorFixture as monitor,
  renderApp,
} from './helpers.js';

function checkResult(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    monitorId: '11111111-1111-4111-8111-111111111111',
    status: 'success',
    httpStatus: 200,
    responseTimeMs: 143,
    errorType: null,
    errorMessage: null,
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderMonitors(
  responses: (Response | Error)[],
  monitorOverrides: Record<string, unknown> = {},
) {
  return renderApp({
    path: '/monitors',
    token: 'token-abc',
    responses: [
      jsonResponse(200, { user: USER }),
      jsonResponse(200, { monitors: [monitor(monitorOverrides)] }),
      ...responses,
    ],
  });
}

describe('manual check', () => {
  it('reports a healthy target with its status and response time', async () => {
    const { getRequests } = renderMonitors([
      jsonResponse(200, { check: checkResult() }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await screen.findByText('Check passed')).toBeTruthy();
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('143 ms')).toBeTruthy();

    const request = getRequests().at(-1);
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(
      '/api/monitors/11111111-1111-4111-8111-111111111111/check',
    );
  });

  /**
   * The distinction this whole feature turns on: the API call succeeded, and
   * what it reports is that the *monitored endpoint* failed.
   */
  it('shows a failing target as a failed check, not a failed request', async () => {
    renderMonitors([
      jsonResponse(200, {
        check: checkResult({
          status: 'failure',
          httpStatus: 503,
          responseTimeMs: 87,
          errorType: 'status_mismatch',
          errorMessage: 'expected 200, received 503',
        }),
      }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    const summary = await screen.findByRole('status');
    expect(summary.textContent).toContain('Check failed');
    expect(summary.textContent).toContain('Unexpected status');
    expect(screen.getByText('503')).toBeTruthy();
    expect(screen.getByText('expected 200, received 503')).toBeTruthy();

    // Crucially: no request-level error is shown.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a timed-out target with no HTTP status', async () => {
    renderMonitors([
      jsonResponse(200, {
        check: checkResult({
          status: 'failure',
          httpStatus: null,
          responseTimeMs: 5000,
          errorType: 'timeout',
          errorMessage: 'no response within 5000 ms',
        }),
      }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    const summary = await screen.findByRole('status');
    expect(summary.textContent).toContain('Timed out');
    expect(summary.textContent).not.toContain('HTTP status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('runs on a paused monitor', async () => {
    const { getRequests } = renderMonitors(
      [jsonResponse(200, { check: checkResult() })],
      { active: false },
    );

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    expect(screen.getByText('Paused')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await screen.findByText('Check passed')).toBeTruthy();
    expect(getRequests().at(-1)?.url).toContain('/check');
  });

  it('reports a request failure as an error, not as a check result', async () => {
    renderMonitors([errorResponse(429, 'rate_limited', 'Too many checks')]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Too many manual checks');
    expect(screen.queryByText(/check passed|check failed/i)).toBeNull();
  });

  it('reports an unreachable API without inventing a check result', async () => {
    renderMonitors([new TypeError('Failed to fetch')]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unable to reach API Watchdog',
    );
    expect(screen.queryByText(/check passed|check failed/i)).toBeNull();
  });

  it('sends one request however fast the button is clicked', async () => {
    const { fetchImpl } = renderMonitors([
      jsonResponse(200, { check: checkResult() }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });

    const button = screen.getByRole('button', { name: 'Check now' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByText('Check passed');
    await waitFor(() => {
      // Bootstrap, list, one check.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });
});
