import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  USER,
  errorResponse,
  jsonResponse,
  monitorFixture as monitor,
  renderApp,
} from './helpers.js';

/** Every monitor screen sits behind the session bootstrap. */
function renderMonitors(responses: (Response | Error)[], path = '/monitors') {
  return renderApp({
    path,
    token: 'token-abc',
    responses: [jsonResponse(200, { user: USER }), ...responses],
  });
}

describe('monitor list', () => {
  it('shows a loading state, then the monitors', async () => {
    renderMonitors([jsonResponse(200, { monitors: [monitor()] })]);

    expect(await screen.findByText('Loading monitors…')).toBeTruthy();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Checkout API' }),
    ).toBeTruthy();
    expect(screen.getByText('https://api.example.com/health')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('HTTP 200')).toBeTruthy();
    expect(screen.getByText('every 5 minutes')).toBeTruthy();
  });

  it('offers every action on a monitor', async () => {
    renderMonitors([jsonResponse(200, { monitors: [monitor()] })]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });

    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit' })).toBeTruthy();
  });

  it('says Resume rather than Pause for a paused monitor', async () => {
    renderMonitors([
      jsonResponse(200, { monitors: [monitor({ active: false })] }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });

    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    // A paused monitor can still be checked by hand.
    expect(
      screen
        .getByRole('button', { name: 'Check now' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('shows an empty state with a way to create the first monitor', async () => {
    renderMonitors([jsonResponse(200, { monitors: [] })]);

    expect(await screen.findByText('No monitors yet')).toBeTruthy();
    // The same label as everywhere else that starts this journey.
    expect(
      screen.getAllByRole('link', { name: 'Add monitor' }).length,
    ).toBeGreaterThan(0);
  });

  it('reports a failed load and can retry it', async () => {
    const { enqueue } = renderMonitors([
      errorResponse(500, 'internal_error', 'ECONNREFUSED 10.0.0.4:5432'),
    ]);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).not.toContain('10.0.0.4');

    enqueue(jsonResponse(200, { monitors: [monitor()] }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Checkout API' }),
    ).toBeTruthy();
  });

  it('reports an unreachable API in plain language', async () => {
    renderMonitors([new TypeError('Failed to fetch')]);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unable to reach API Watchdog',
    );
  });

  it('sends the bearer token with the list request', async () => {
    const { getRequests } = renderMonitors([
      jsonResponse(200, { monitors: [] }),
    ]);

    await screen.findByText('No monitors yet');

    const listRequest = getRequests().find(
      (request) => request.url === '/api/monitors',
    );
    expect(listRequest?.headers.get('Authorization')).toBe('Bearer token-abc');
  });
});

describe('pause and resume', () => {
  it('patches active and shows the state the server returned', async () => {
    const { getRequests } = renderMonitors([
      jsonResponse(200, { monitors: [monitor()] }),
      jsonResponse(200, { monitor: monitor({ active: false }) }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();

    const patch = getRequests().at(-1);
    expect(patch?.method).toBe('PATCH');
    expect(patch?.url).toBe(
      '/api/monitors/11111111-1111-4111-8111-111111111111',
    );
    expect(patch?.body).toEqual({ active: false });
  });

  it('shows a pending label and refuses a second click', async () => {
    const { fetchImpl } = renderMonitors([
      jsonResponse(200, { monitors: [monitor()] }),
      jsonResponse(200, { monitor: monitor({ active: false }) }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });

    const pause = screen.getByRole('button', { name: 'Pause' });
    fireEvent.click(pause);
    fireEvent.click(pause);
    fireEvent.click(pause);

    await screen.findByRole('button', { name: 'Resume' });
    await waitFor(() => {
      // One bootstrap, one list, one patch — no duplicates.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });

  it('keeps the displayed state when the patch fails', async () => {
    renderMonitors([
      jsonResponse(200, { monitors: [monitor()] }),
      errorResponse(429, 'rate_limited', 'Too many requests'),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Too many requests',
    );
    // Still active, and the control is usable again.
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });
});

describe('delete', () => {
  it('asks for confirmation before deleting anything', async () => {
    const { fetchImpl } = renderMonitors([
      jsonResponse(200, { monitors: [monitor()] }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/cannot be undone/i)).toBeTruthy();
    // Nothing beyond the bootstrap and the list has been requested.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('can be cancelled', async () => {
    renderMonitors([jsonResponse(200, { monitors: [monitor()] })]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
  });

  it('removes the monitor once the delete succeeds', async () => {
    const { getRequests } = renderMonitors([
      jsonResponse(200, { monitors: [monitor()] }),
      new Response(null, { status: 204 }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete monitor' }),
    );

    expect(await screen.findByText('No monitors yet')).toBeTruthy();
    expect(getRequests().at(-1)?.method).toBe('DELETE');
  });

  it('sends one request however fast the button is clicked', async () => {
    const { fetchImpl } = renderMonitors([
      jsonResponse(200, { monitors: [monitor()] }),
      new Response(null, { status: 204 }),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const confirm = await screen.findByRole('button', {
      name: 'Delete monitor',
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await screen.findByText('No monitors yet');
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });

  it('keeps the monitor and explains the failure', async () => {
    renderMonitors([
      jsonResponse(200, { monitors: [monitor()] }),
      errorResponse(404, 'not_found', 'Monitor not found'),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Checkout API' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete monitor' }),
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'no longer exists',
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'Checkout API' }),
    ).toBeTruthy();
  });
});
