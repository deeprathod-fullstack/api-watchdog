import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  USER,
  dashboardMonitorFixture as monitor,
  dashboardWith,
  errorResponse,
  jsonResponse,
  renderApp,
  type FakeResponse,
} from './helpers.js';

const MONITOR_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Every monitor screen sits behind the session bootstrap.
 *
 * The list reads `GET /api/dashboard`, the one endpoint carrying per-monitor
 * health, so that is what the queue serves.
 */
function renderMonitors(responses: FakeResponse[], path = '/monitors') {
  return renderApp({
    path,
    token: 'token-abc',
    responses: [jsonResponse(200, { user: USER }), ...responses],
  });
}

/** The row for one monitor, found by the name in its row header. */
function row(name: string): HTMLElement {
  return screen
    .getByText(name, { selector: '.monitor__name' })
    .closest('tr') as HTMLElement;
}

describe('monitor list', () => {
  it('shows a loading state, then the monitors', async () => {
    renderMonitors([dashboardWith([monitor()])]);

    expect(await screen.findByText('Loading monitors…')).toBeTruthy();

    expect(await screen.findByText('Checkout API')).toBeTruthy();
    expect(screen.getByText('https://api.example.com/health')).toBeTruthy();

    // The columns the table exists to show.
    const checkout = row('Checkout API');
    expect(within(checkout).getByText('Healthy')).toBeTruthy();
    expect(within(checkout).getByText('200')).toBeTruthy();
    expect(within(checkout).getByText('143 ms')).toBeTruthy();
  });

  it('labels its columns', async () => {
    renderMonitors([dashboardWith([monitor()])]);

    await screen.findByText('Checkout API');
    const headers = screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent);

    expect(headers).toEqual([
      'Monitor',
      'Status',
      'Expected',
      'Last check',
      'Response',
      'Actions',
    ]);
  });

  it('offers every action on a monitor, named for that monitor', async () => {
    renderMonitors([dashboardWith([monitor()])]);

    await screen.findByText('Checkout API');

    // Several rows each show a control reading "Check" or "Delete", so each
    // one has to say which monitor it acts on.
    expect(
      screen.getByRole('button', { name: 'Check Checkout API now' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Pause Checkout API' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Delete Checkout API' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Edit Checkout API' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'History for Checkout API' }),
    ).toBeTruthy();
  });

  it('says Resume rather than Pause for a paused monitor', async () => {
    renderMonitors([dashboardWith([monitor({ active: false })])]);

    await screen.findByText('Checkout API');
    const checkout = row('Checkout API');

    // Paused is shown alongside health, not instead of it: pausing stops the
    // schedule, it does not make the last result untrue.
    expect(within(checkout).getByText('Paused')).toBeTruthy();
    expect(within(checkout).getByText('Healthy')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Resume Checkout API' }),
    ).toBeTruthy();
    // A paused monitor can still be checked by hand.
    expect(
      screen
        .getByRole('button', { name: 'Check Checkout API now' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('marks a monitor with an open incident', async () => {
    renderMonitors([
      dashboardWith([monitor({ latestStatus: 'failure', incidentOpen: true })]),
    ]);

    await screen.findByText('Checkout API');
    const checkout = row('Checkout API');

    expect(within(checkout).getByText('Failing')).toBeTruthy();
    expect(within(checkout).getByText('Incident')).toBeTruthy();
  });

  it('does not invent a response time when none was recorded', async () => {
    renderMonitors([
      dashboardWith([
        monitor({
          latestStatus: 'failure',
          latestHttpStatus: null,
          latestResponseTimeMs: null,
        }),
      ]),
    ]);

    await screen.findByText('Checkout API');
    const checkout = row('Checkout API');

    expect(within(checkout).getByText('—')).toBeTruthy();
    expect(within(checkout).queryByText('0 ms')).toBeNull();
  });

  it('says so when a monitor has never been checked', async () => {
    renderMonitors([
      dashboardWith([
        monitor({
          latestStatus: null,
          latestHttpStatus: null,
          latestResponseTimeMs: null,
          latestCheckedAt: null,
        }),
      ]),
    ]);

    await screen.findByText('Checkout API');
    const checkout = row('Checkout API');

    expect(within(checkout).getByText('No check yet')).toBeTruthy();
    expect(within(checkout).getByText('Never')).toBeTruthy();
    expect(within(checkout).queryByText('Healthy')).toBeNull();
  });

  it('shows an empty state with a way to create the first monitor', async () => {
    renderMonitors([dashboardWith([])]);

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

    enqueue(dashboardWith([monitor()]));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Checkout API')).toBeTruthy();
  });

  it('reports an unreachable API in plain language', async () => {
    renderMonitors([new TypeError('Failed to fetch')]);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unable to reach API Watchdog',
    );
  });

  it('reads health from one request, never one per row', async () => {
    const { getRequests } = renderMonitors([
      dashboardWith([
        monitor({ id: 'a', name: 'First' }),
        monitor({ id: 'b', name: 'Second' }),
        monitor({ id: 'c', name: 'Third' }),
      ]),
    ]);

    await screen.findByText('Third');

    const calls = getRequests().filter((r) => r.url.startsWith('/api/'));
    // The session bootstrap and exactly one dashboard read.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('/api/dashboard');
    expect(calls[1]?.headers.get('Authorization')).toBe('Bearer token-abc');
  });
});

describe('pause and resume', () => {
  it('patches active and shows the state the server returned', async () => {
    const { getRequests } = renderMonitors([
      dashboardWith([monitor()]),
      jsonResponse(200, { monitor: { active: false } }),
      dashboardWith([monitor({ active: false })]),
    ]);

    await screen.findByText('Checkout API');
    fireEvent.click(screen.getByRole('button', { name: 'Pause Checkout API' }));

    expect(
      await screen.findByRole('button', { name: 'Resume Checkout API' }),
    ).toBeTruthy();
    expect(within(row('Checkout API')).getByText('Paused')).toBeTruthy();

    const patch = getRequests().find((r) => r.method === 'PATCH');
    expect(patch?.url).toBe(`/api/monitors/${MONITOR_ID}`);
    expect(patch?.body).toEqual({ active: false });
  });

  it('re-reads the list so the summary cannot go stale', async () => {
    const { getRequests } = renderMonitors([
      dashboardWith([monitor()]),
      jsonResponse(200, { monitor: { active: false } }),
      dashboardWith([monitor({ active: false })]),
    ]);

    await screen.findByText('Checkout API');
    fireEvent.click(screen.getByRole('button', { name: 'Pause Checkout API' }));

    await screen.findByRole('button', { name: 'Resume Checkout API' });

    // Pausing changes what the counts should say, so the row is not patched in
    // place — the list is read again.
    expect(
      getRequests().filter((r) => r.url === '/api/dashboard'),
    ).toHaveLength(2);
  });

  it('shows a pending label and refuses a second click', async () => {
    const { getRequests } = renderMonitors([
      dashboardWith([monitor()]),
      jsonResponse(200, { monitor: { active: false } }),
      dashboardWith([monitor({ active: false })]),
    ]);

    await screen.findByText('Checkout API');

    const pause = screen.getByRole('button', { name: 'Pause Checkout API' });
    fireEvent.click(pause);
    fireEvent.click(pause);
    fireEvent.click(pause);

    await screen.findByRole('button', { name: 'Resume Checkout API' });
    await waitFor(() => {
      // Exactly one PATCH, however many times the control was clicked.
      expect(getRequests().filter((r) => r.method === 'PATCH')).toHaveLength(1);
    });
  });

  it('keeps the displayed state when the patch fails', async () => {
    renderMonitors([
      dashboardWith([monitor()]),
      errorResponse(429, 'rate_limited', 'Too many requests'),
    ]);

    await screen.findByText('Checkout API');
    fireEvent.click(screen.getByRole('button', { name: 'Pause Checkout API' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Too many requests',
    );
    // Still active — no "Paused" badge — and the control is usable again.
    expect(within(row('Checkout API')).queryByText('Paused')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Pause Checkout API' }),
    ).toBeTruthy();
  });
});

describe('delete', () => {
  it('asks for confirmation before deleting anything', async () => {
    const { getRequests } = renderMonitors([dashboardWith([monitor()])]);

    await screen.findByText('Checkout API');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Checkout API' }),
    );

    expect(await screen.findByText(/cannot be undone/i)).toBeTruthy();
    // Nothing beyond the bootstrap and the list has been requested.
    expect(getRequests().filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('moves focus to the confirm button, and back on cancel', async () => {
    renderMonitors([dashboardWith([monitor()])]);

    await screen.findByText('Checkout API');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Checkout API' }),
    );

    // The button that opened the confirmation no longer exists, so focus has
    // to be placed deliberately or it falls back to the document.
    const confirm = await screen.findByRole('button', {
      name: 'Delete monitor',
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(confirm);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    const deleteButton = await screen.findByRole('button', {
      name: 'Delete Checkout API',
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(deleteButton);
    });
  });

  it('can be cancelled', async () => {
    renderMonitors([dashboardWith([monitor()])]);

    await screen.findByText('Checkout API');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Checkout API' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(
      screen.getByRole('button', { name: 'Check Checkout API now' }),
    ).toBeTruthy();
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
  });

  it('removes the monitor once the delete succeeds', async () => {
    const { getRequests } = renderMonitors([
      dashboardWith([monitor()]),
      new Response(null, { status: 204 }),
      dashboardWith([]),
    ]);

    await screen.findByText('Checkout API');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Checkout API' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete monitor' }),
    );

    expect(await screen.findByText('No monitors yet')).toBeTruthy();
    expect(getRequests().some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('sends one request however fast the button is clicked', async () => {
    const { getRequests } = renderMonitors([
      dashboardWith([monitor()]),
      new Response(null, { status: 204 }),
      dashboardWith([]),
    ]);

    await screen.findByText('Checkout API');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Checkout API' }),
    );

    const confirm = await screen.findByRole('button', {
      name: 'Delete monitor',
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await screen.findByText('No monitors yet');
    await waitFor(() => {
      expect(getRequests().filter((r) => r.method === 'DELETE')).toHaveLength(
        1,
      );
    });
  });

  it('keeps the monitor and explains the failure', async () => {
    renderMonitors([
      dashboardWith([monitor()]),
      errorResponse(404, 'not_found', 'Monitor not found'),
    ]);

    await screen.findByText('Checkout API');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Checkout API' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete monitor' }),
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'no longer exists',
    );
    expect(screen.getByText('Checkout API')).toBeTruthy();
  });
});
