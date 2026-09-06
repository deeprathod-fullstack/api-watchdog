import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  USER,
  errorResponse,
  jsonResponse,
  renderApp,
  type FakeResponse,
} from './helpers.js';

/** One dashboard monitor, with the payload's real field names. */
function dashMonitor(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Checkout API',
    url: 'https://api.example.com/health',
    active: true,
    expectedStatus: 200,
    intervalSeconds: 300,
    timeoutMs: 5000,
    latestStatus: 'success',
    latestHttpStatus: 200,
    latestResponseTimeMs: 143,
    latestCheckedAt: '2026-01-01T00:00:00.000Z',
    incidentOpen: false,
    ...overrides,
  };
}

function dashboard(
  monitors: Record<string, unknown>[],
  summaryOverrides: Record<string, number> = {},
) {
  return jsonResponse(200, {
    summary: {
      total: monitors.length,
      active: monitors.filter((m) => m.active !== false).length,
      healthy: monitors.filter((m) => m.latestStatus === 'success').length,
      failing: monitors.filter((m) => m.latestStatus === 'failure').length,
      unknown: monitors.filter((m) => m.latestStatus === null).length,
      openIncidents: monitors.filter((m) => m.incidentOpen === true).length,
      ...summaryOverrides,
    },
    monitors,
  });
}

/** The dashboard sits behind the session bootstrap, like every other screen. */
function renderDashboard(responses: FakeResponse[]) {
  return renderApp({
    path: '/',
    token: 'token-abc',
    responses: [jsonResponse(200, { user: USER }), ...responses],
  });
}

/**
 * Read a summary card by its label, so the assertion names what it reads.
 *
 * Scoped to the summary list: "Monitors" is also a navigation link, and a
 * monitor's name appears in both the health list and the latest-checks table.
 */
function cardValue(label: string): string | null {
  const cards = screen.getByLabelText('Monitoring summary');
  const card = within(cards).getByText(label).closest('.card');
  return card?.querySelector('.card__value')?.textContent ?? null;
}

/** The "Monitor health" section, where each monitor appears exactly once. */
function healthSection(): HTMLElement {
  const heading = screen.getByRole('heading', {
    level: 2,
    name: 'Monitor health',
  });
  return heading.closest('section') as HTMLElement;
}

/**
 * One monitor's row within the health list.
 *
 * Matched on the name element specifically: each row's "Edit" link carries the
 * monitor's name in visually-hidden text so its accessible name says which
 * monitor it edits, and a bare text query would match both.
 */
function healthRow(name: string): HTMLElement {
  return within(healthSection())
    .getByText(name, { selector: '.health__name' })
    .closest('li') as HTMLElement;
}

describe('dashboard loading and errors', () => {
  it('shows a loading state rather than a page of zeros', async () => {
    // A request that never settles, so the in-flight state is observable
    // rather than a race against the fake resolving.
    renderDashboard([new Promise<Response>(() => undefined)]);

    expect(await screen.findByText('Loading dashboard…')).toBeTruthy();
    // No misleading counts, and no empty state, before the data arrives.
    expect(screen.queryByLabelText('Monitoring summary')).toBeNull();
    expect(screen.queryByText('No monitors yet')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a failed load and retries it', async () => {
    const { enqueue } = renderDashboard([
      errorResponse(500, 'internal_error', 'ECONNREFUSED 10.0.0.4:5432'),
    ]);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).not.toContain('10.0.0.4');

    enqueue(dashboard([dashMonitor()]));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Monitor health' }),
    ).toBeTruthy();
  });

  it('reports an unreachable API in plain language', async () => {
    renderDashboard([new TypeError('Failed to fetch')]);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unable to reach API Watchdog',
    );
  });

  it('treats a malformed payload as an error rather than crashing', async () => {
    renderDashboard([jsonResponse(200, { summary: null, monitors: 'nope' })]);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Something went wrong',
    );
  });

  it('issues exactly one dashboard request', async () => {
    const { getRequests } = renderDashboard([dashboard([dashMonitor()])]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    const dashboardRequests = getRequests().filter(
      (request) => request.url === '/api/dashboard',
    );
    expect(dashboardRequests).toHaveLength(1);
    expect(dashboardRequests[0]?.headers.get('Authorization')).toBe(
      'Bearer token-abc',
    );
    // No per-monitor follow-up calls.
    expect(
      getRequests().filter((request) =>
        request.url.startsWith('/api/monitors'),
      ),
    ).toHaveLength(0);
  });
});

describe('dashboard overview', () => {
  it('shows every summary metric from the backend', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({ id: 'a', latestStatus: 'success' }),
        dashMonitor({ id: 'b', latestStatus: 'failure', incidentOpen: true }),
        dashMonitor({
          id: 'c',
          latestStatus: null,
          latestHttpStatus: null,
          latestResponseTimeMs: null,
          latestCheckedAt: null,
        }),
        dashMonitor({ id: 'd', active: false, latestStatus: 'success' }),
      ]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    expect(cardValue('Monitors')).toBe('4');
    expect(cardValue('Healthy')).toBe('2');
    expect(cardValue('Failing')).toBe('1');
    expect(cardValue('No check yet')).toBe('1');
    // total - active, the only thing `active` can mean.
    expect(cardValue('Paused')).toBe('1');
    expect(cardValue('Open incidents')).toBe('1');
  });
});

describe('monitor health presentation', () => {
  it('shows a healthy monitor with its latest check details', async () => {
    renderDashboard([dashboard([dashMonitor()])]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });
    const row = healthRow('Checkout API');

    expect(
      within(row).getByText('https://api.example.com/health'),
    ).toBeTruthy();
    expect(within(row).getByText('Healthy')).toBeTruthy();
    expect(within(row).getByText('200')).toBeTruthy();
    expect(within(row).getByText('143 ms')).toBeTruthy();
  });

  it('distinguishes a failing monitor from a paused one', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({
          id: 'a',
          name: 'Failing API',
          latestStatus: 'failure',
          latestHttpStatus: 503,
        }),
        dashMonitor({ id: 'b', name: 'Paused API', active: false }),
      ]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    const failing = healthRow('Failing API');
    expect(within(failing).getByText('Failing')).toBeTruthy();
    expect(within(failing).queryByText('Paused')).toBeNull();

    const paused = healthRow('Paused API');
    expect(within(paused).getByText('Paused')).toBeTruthy();
    // Paused says nothing about health: this one's last check passed.
    expect(within(paused).getByText('Healthy')).toBeTruthy();
    expect(within(paused).queryByText('Failing')).toBeNull();
  });

  it('shows a paused monitor that was failing as both', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({
          name: 'Paused and failing',
          active: false,
          latestStatus: 'failure',
        }),
      ]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    const row = healthRow('Paused and failing');
    expect(within(row).getByText('Failing')).toBeTruthy();
    expect(within(row).getByText('Paused')).toBeTruthy();
  });

  it('distinguishes a never-checked monitor from a healthy one', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({
          name: 'Brand new',
          latestStatus: null,
          latestHttpStatus: null,
          latestResponseTimeMs: null,
          latestCheckedAt: null,
        }),
      ]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    const row = healthRow('Brand new');
    expect(within(row).getByText('No check yet')).toBeTruthy();
    expect(within(row).queryByText('Healthy')).toBeNull();
    expect(within(row).getByText('Never checked')).toBeTruthy();
  });

  it('does not invent a response time when none was recorded', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({
          name: 'Timed out',
          latestStatus: 'failure',
          latestHttpStatus: null,
          latestResponseTimeMs: null,
        }),
      ]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    const row = healthRow('Timed out');
    // A dash, not "0 ms".
    expect(within(row).queryByText('0 ms')).toBeNull();
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
  });

  /** A failed check is monitoring data, not a dashboard failure. */
  it('renders a failing monitor without raising a page error', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({ latestStatus: 'failure', latestHttpStatus: 503 }),
      ]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/could not load your dashboard/i)).toBeNull();
  });
});

describe('open incidents', () => {
  it('lists a monitor with an open incident', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({
          name: 'Broken API',
          latestStatus: 'failure',
          latestHttpStatus: 503,
          incidentOpen: true,
        }),
      ]),
    ]);

    const heading = await screen.findByRole('heading', {
      level: 2,
      name: 'Open incidents',
    });
    const section = heading.closest('section') as HTMLElement;

    expect(
      within(section).getByText('Broken API', { selector: '.incident__name' }),
    ).toBeTruthy();
    expect(within(section).getByText('Open')).toBeTruthy();
    expect(within(section).getAllByText('503').length).toBeGreaterThan(0);
  });

  it('shows a neutral empty state when nothing is broken', async () => {
    renderDashboard([dashboard([dashMonitor()])]);

    expect(await screen.findByText('No open incidents')).toBeTruthy();
  });

  it('offers no resolve control, since the API has none', async () => {
    renderDashboard([
      dashboard([dashMonitor({ latestStatus: 'failure', incidentOpen: true })]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Open incidents' });

    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
  });
});

describe('latest checks', () => {
  it('lists the most recently checked monitors first', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({
          id: 'a',
          name: 'Older',
          latestCheckedAt: '2026-01-01T00:00:00.000Z',
        }),
        dashMonitor({
          id: 'b',
          name: 'Newer',
          latestCheckedAt: '2026-01-02T00:00:00.000Z',
        }),
      ]),
    ]);

    const heading = await screen.findByRole('heading', {
      level: 2,
      name: 'Latest checks',
    });
    const rows = within(heading.closest('section') as HTMLElement).getAllByRole(
      'row',
    );

    // Row 0 is the header.
    expect(rows[1]?.textContent).toContain('Newer');
    expect(rows[2]?.textContent).toContain('Older');
  });

  it('says so when no check has run yet', async () => {
    renderDashboard([
      dashboard([
        dashMonitor({
          latestStatus: null,
          latestHttpStatus: null,
          latestResponseTimeMs: null,
          latestCheckedAt: null,
        }),
      ]),
    ]);

    expect(await screen.findByText(/no checks yet/i)).toBeTruthy();
  });
});

describe('empty dashboard', () => {
  it('invites a brand-new user to add their first monitor', async () => {
    renderDashboard([dashboard([])]);

    expect(await screen.findByText('No monitors yet')).toBeTruthy();

    const add = screen.getByRole('link', { name: 'Add monitor' });
    expect(add.getAttribute('href')).toBe('/monitors/new');
    // Not an error, and no empty sections implying something is broken.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Open incidents')).toBeNull();
  });

  it('navigates to the create form from the empty state', async () => {
    renderDashboard([dashboard([])]);

    fireEvent.click(await screen.findByRole('link', { name: 'Add monitor' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'New monitor' }),
    ).toBeTruthy();
  });
});

describe('refresh', () => {
  it('reloads the dashboard and shows the new data', async () => {
    const { getRequests } = renderDashboard([
      dashboard([
        dashMonitor({ latestStatus: 'failure', latestHttpStatus: 503 }),
      ]),
      dashboard([
        dashMonitor({ latestStatus: 'success', latestHttpStatus: 200 }),
      ]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });
    expect(cardValue('Failing')).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(cardValue('Healthy')).toBe('1');
    });
    expect(cardValue('Failing')).toBe('0');

    expect(
      getRequests().filter((request) => request.url === '/api/dashboard'),
    ).toHaveLength(2);
  });

  it('sends one request however fast the button is clicked', async () => {
    const { getRequests } = renderDashboard([
      dashboard([dashMonitor()]),
      dashboard([dashMonitor({ name: 'Refreshed' })]),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    const button = screen.getByRole('button', { name: 'Refresh' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await within(healthSection()).findByText('Refreshed', {
      selector: '.health__name',
    });
    await waitFor(() => {
      expect(
        getRequests().filter((request) => request.url === '/api/dashboard'),
      ).toHaveLength(2);
    });
  });

  it('shows an error instead of stale numbers when a refresh fails', async () => {
    renderDashboard([
      dashboard([dashMonitor()]),
      errorResponse(500, 'internal_error', 'boom'),
    ]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Something went wrong',
    );
    // The old counts are gone rather than sitting under the banner as current.
    expect(screen.queryByLabelText('Monitoring summary')).toBeNull();
  });
});

describe('dashboard navigation', () => {
  it('names the page in the browser', async () => {
    renderDashboard([dashboard([dashMonitor()])]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });
    expect(document.title).toBe('Dashboard · API Watchdog');
  });

  it('links to the monitor list and the create form', async () => {
    renderDashboard([dashboard([dashMonitor()])]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    expect(
      screen.getByRole('link', { name: 'View monitors' }).getAttribute('href'),
    ).toBe('/monitors');
    expect(
      screen.getByRole('link', { name: 'Add monitor' }).getAttribute('href'),
    ).toBe('/monitors/new');
  });

  it('links each monitor to its edit page, named for the monitor', async () => {
    renderDashboard([dashboard([dashMonitor()])]);

    await screen.findByRole('heading', { level: 2, name: 'Monitor health' });

    const link = within(healthSection()).getByRole('link', {
      name: 'Edit Checkout API',
    });
    expect(link.getAttribute('href')).toBe(
      '/monitors/11111111-1111-4111-8111-111111111111/edit',
    );
  });

  it('still sends a signed-out visitor to sign in', async () => {
    const { fetchImpl } = renderApp({ path: '/' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
